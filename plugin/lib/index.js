// ============================================================================
// dsh-agent-commander — Node half
//
// Multi-agent commander for DeepSeek Harness:
//   • AgentRegistry spawns real agent CLIs (claude / opencode / codex) in
//     project directories as PTY processes, injects each agent's role & skill
//     briefing on spawn, keeps a bounded transcript, and derives a live status.
//   • Model-facing tools: agent_open / agent_list / agent_read / agent_send /
//     agent_signal / agent_close — so DeepSeek can open agents, dispatch tasks
//     and collect results (the commander pattern).
//   • HTTP API + WebSocket routes back the right-side "Agent Radar" panel
//     (create agents with role/skill dialogs, watch live terminal output).
//
// Shared memory contract (enforced by the agent-commander skill, not by this
// plugin): every agent works in the same project directory and reads/writes
// .deepseek/memory.md, .deepseek/task-board.md, .deepseek/experience.md,
// .deepseek/handoffs/ (handoffs) and the SQLite knowledge base
// .deepseek/memory.db (node:sqlite, seeded by this plugin).
// ============================================================================

import { createRequire } from "node:module";
import { existsSync, chmodSync, readdirSync, writeFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, isAbsolute, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { TerminalAgentRegistry, ENGINE_TYPES } from "./terminal-registry.js";
import { SessionScanner } from "./session-scanner.js";
import { TerminalLauncher } from "./terminal-launcher.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Fallback module resolution — this plugin may be installed into a profile as
// a pnpm `link:` (symlink → the checkout), a manual copy, a tarball, or a git
// clone. Node resolves the plugin's file to its realpath by default, so bare
// `require("ws")` / `require("node-pty")` can miss the profile's node_modules.
// The Harness guarantees a mirror of the app's ENTIRE dependency tree at
// ~/.dsh/profiles/node_modules (healProfilesModuleFallback), so we resolve
// against that anchor (plus the app's own host root) as a fallback chain.
// ---------------------------------------------------------------------------
function moduleAnchors() {
	const anchors = [import.meta.url];
	try {
		anchors.push(pathToFileURL(join(homedir(), ".dsh", "profiles", "node_modules", "package.json")).href);
	} catch {}
	try {
		anchors.push(pathToFileURL(join(dirname(process.execPath), "..", "Resources", "host", "package.json")).href);
	} catch {}
	return anchors;
}
const fallbackRequire = (() => {
	const anchors = moduleAnchors();
	return (spec) => {
		let lastError = null;
		for (const anchor of anchors) {
			try {
				return createRequire(anchor)(spec);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error(`cannot resolve "${spec}" from any module anchor`);
	};
})();
/** Lazy `ws` — resolved through the anchor chain so terminal WebSockets work no matter how the plugin was installed. */
let wsModule = null;
function getWs() {
	if (wsModule === null) wsModule = fallbackRequire("ws");
	return wsModule;
}

const API_PREFIX = "/agent-commander/api";
const WS_LIST = "/agent-commander/ws/list";
const TRANSCRIPT_LIMIT = 1 << 20; // 1 MiB per agent transcript ring
const MAX_AGENTS_DEFAULT = 8;
const BODY_LIMIT = 1 << 20; // 1 MiB request body cap
const WS_INPUT_LIMIT = 64 << 10; // 64 KiB per terminal input frame
const ALLOWED_SIGNALS = ["SIGINT", "SIGTSTP", "SIGTERM"];
const AGENT_TYPES = ["claude", "opencode", "codex", "codebuddy", "pi", "qwen"];
// ---------------------------------------------------------------------------
// Startup / exit monitor — a per-agent lifecycle watcher.
//
// On spawn it watches the live transcript until the CLI has FORMALLY entered
// its UI: it auto-answers boot prompts along the way (claude's folder-trust
// menu "1. Yes, I trust this folder / Enter to confirm", generic y/n
// confirmations), then injects the role/skill briefing and SUBMITS it with
// Enter (回车执行), keeps auto-answering prompts until the first task finishes,
// and only then exits the monitor. A fixed delay is unreliable: opencode boots
// with a continuously animating spinner for many seconds and swallows any text
// written mid-boot, and an Enter that lands during a TUI redraw leaves the
// prompt text sitting unexecuted on the input line.
//
// On close the monitor flips to "exit" phase and the handle stays visible as
// 退出中 until the PTY process has fully exited.
// ---------------------------------------------------------------------------
const MONITOR_POLL_MS = 400;
const MONITOR_BOOT_GRACE = 1200;    // min ms after spawn before readiness counts
const MONITOR_QUIET_MS = 900;       // ms of output silence = "settled at the prompt"
const MONITOR_CAP_MS = 25000;       // boot+inject must happen within this
const MONITOR_OPENCODE_CAP_MS = 120000; // opencode boots slow (MCP/plugin loading): backstop only
const MONITOR_OPENCODE_VERIFY_MS = 20000; // cadence for db-verifying opencode briefing delivery
const MONITOR_OPENCODE_MAX_INJECTS = 5;   // re-inject attempts while its TUI is still booting
const MONITOR_ENTER_DELAY = 350;    // ms between writing text and pressing Enter
const MONITOR_ENTER_RETRY_MS = 1500; // re-press Enter if no reaction by then
const MONITOR_MAX_ENTERS = 3;
const MONITOR_TASK_QUIET_MS = 8000; // output quiet this long after activity = first task done
const MONITOR_TOTAL_CAP_MS = 300000; // 5 min: total monitor lifetime (long first task)
const MONITOR_ANSWER_REPEAT_MS = 20000; // same question signature re-answered after this
// Status sweep: periodically re-evaluate "working" agents that stopped producing
// output. opencode's idle TUI has no Claude-specific markers, so deriveStatus()
// alone cannot detect its idle state — the sweep catches quiet agents instead.
const STATUS_IDLE_AFTER_MS = 25000;   // ms of silence before a "working" agent is re-checked
const STATUS_ACTIVE_RE = /[⠀-⣿]|Thinking|Forming|Brewing|Wrangling|Boogie|working on|Reading |esc to interrupt/i;
// Prompts to auto-answer. `enter` confirms with Enter only (menus whose default
// is the safe choice, e.g. claude's folder trust); `y` answers y + Enter.
// Matched against the whitespace-stripped transcript tail.
const MONITOR_QUESTION_PATTERNS = [
	{ re: /Entertoconfirm·Esctocancel|1\.Yes,Itrustthisfolder|Quicksafetycheck|Doyoutrustthefilesinthisfolder/, enter: true },
	{ re: /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No/, y: true },
	{ re: /PressEnterto|Entertoselect|Selectanoption/, enter: true }
];
/**
* Graceful-exit command per engine (research: claude/codebuddy/qwen use /exit;
* pi supports /exit and /quit; codex exits on `exit`; opencode has NO text exit —
* its TUI exits on double Ctrl+C, so we skip the text and rely on SIGINT escalation).
*/
const EXIT_COMMANDS = {
	claude: "/exit",
	codebuddy: "/exit",
	qwen: "/exit",
	pi: "/exit",
	codex: "exit",
	opencode: ""
};
const ROLE_PRESETS = ["数据库专家", "设计专家", "前端专家", "测试专家", "代码审查专家", "架构师"];
/**
* New-conversation command per engine (research): claude/codebuddy/qwen clear
* the conversation with /clear; opencode/codex/pi start a fresh session with /new.
*/
const NEW_SESSION_COMMANDS = {
	claude: "/clear",
	codebuddy: "/clear",
	qwen: "/clear",
	opencode: "/new",
	codex: "/new",
	pi: "/new"
};
/**
* Compact-session command per engine: compresses the current conversation
* context to reduce token usage without starting a fresh session.
* claude/codebuddy/qwen use /compact; opencode/codex/pi have no known
* compact command so we omit them (the UI disables the button for those).
*/
const COMPACT_SESSION_COMMANDS = {
	claude: "/compact",
	codebuddy: "/compact",
	qwen: "/compact"
};
/** Plugin data dir for the global workspace index (survives restarts, independent of any project). */
function dshDataDir() {
	return join(homedir(), ".dsh", "agent-commander");
}
/** Recursively walk files under a dir matching a predicate (safely). */
function walkFiles(dir, predicate, out = []) {
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walkFiles(p, predicate, out);
			else if (predicate(p)) out.push(p);
		}
	} catch {}
	return out;
}
/** Total bytes of every file under a dir. */
function dirSize(dir) {
	let total = 0;
	try {
		for (const p of walkFiles(dir, () => true)) {
			try {
				total += statSync(p).size;
			} catch {}
		}
	} catch {}
	return total;
}
function statSize(p) {
	try {
		return statSync(p).size;
	} catch {
		return 0;
	}
}
function statOf(p) {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}
/** gzip a file in place: writes <p>.gz and removes the original. */
async function gzipFile(p) {
	const data = readFileSync(p);
	writeFileSync(`${p}.gz`, gzipSync(data, { level: 9 }));
	try {
		unlinkSync(p);
	} catch {}
}

/** Environment whitelist for spawned agents — never leak the harness's secrets. */
const AGENT_ENV_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM_PROGRAM", "CLICOLOR", "NO_COLOR"];

// ---------------------------------------------------------------------------
// Trust fence (same origin discipline as the /api gateway)
// ---------------------------------------------------------------------------
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return void 0;
	}
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === void 0) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}
function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request.headers, "host");
	if (host === void 0) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === void 0) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// node-pty lazy load + spawn-helper fix (same discipline as dsh-better-sidebar)
// ---------------------------------------------------------------------------
function resolveBinary(type) {
	if (!AGENT_TYPES.includes(type)) return null;
	for (const dir of searchPathDirs()) {
		const candidate = join(dir, type);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
function enhancedPath() {
	return searchPathDirs().join(":");
}
function detectBinaries() {
	return AGENT_TYPES.map((type) => {
		const path = resolveBinary(type);
		return { type, available: path !== null, path };
	});
}
function listSkills() {
	const base = join(homedir(), ".agents", "skills");
	try {
		const entries = readdirSync(base, { withFileTypes: true });
		return entries
			.filter((e) => e.isDirectory() && existsSync(join(base, e.name, "skill.md")))
			.map((e) => ({ name: e.name, path: join(base, e.name, "skill.md") }));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Bundled skill self-install — the agent-commander skill ships INSIDE this
// plugin package (skill/agent-commander/skill.md, included in the tarball via
// package.json "files"), so a plain `dsh plugin add` also makes the skill
// available to the model without a separate install step. Best-effort: only
// writes when missing or different, never clobbers user edits.
// ---------------------------------------------------------------------------
function ensureBundledSkillInstalled() {
	try {
		const source = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "agent-commander", "skill.md");
		if (!existsSync(source)) return;
		const targetDir = join(homedir(), ".agents", "skills", "agent-commander");
		const target = join(targetDir, "skill.md");
		const content = readFileSync(source, "utf8");
		const needsWrite = !existsSync(target) || readFileSync(target, "utf8") !== content;
		if (needsWrite) {
			mkdirSync(targetDir, { recursive: true });
			writeFileSync(target, content, "utf8");
			console.info("[dsh-agent-commander] bundled skill installed to ~/.agents/skills/agent-commander/");
		}
	} catch (error) {
		console.warn("[dsh-agent-commander] bundled skill install failed:", error?.message ?? error);
	}
}

// ---------------------------------------------------------------------------
// Shared memory seeding — placed under <project>/.deepseek/ with English file
// names: memory.md (长期记忆) / task-board.md (任务看板) / experience.md
// (经验总结) / handoffs/ (交接区)
// ---------------------------------------------------------------------------
const MEMORY_DIR = ".deepseek";

// ---------------------------------------------------------------------------
// Plugin configuration — a Standard Schema (Schemastery) exported as `Config`,
// per the official plugin standard (docs/user/develop/basic/config.md):
//   1. every deployment-tunable parameter is a config field (no hardcoded
//      constants users cannot change);
//   2. defaults live IN the schema, so the loader fills them in and validates
//      `config` passed to apply() on mount;
//   3. the schema also drives the plugin's settings form in the app UI.
// Users override any field from their profile cordis.patch.yml, e.g.:
//   - id: agent-commander
//     config:
//       maxAgents: 12
//       transcriptLimit: 2097152
//       rolePresets: [数据库专家, 设计专家, 前端专家, 测试专家, 代码审查专家, 架构师, 安全专家]
// ---------------------------------------------------------------------------
export const Config = Schema.object({
	/** Hard cap on concurrently open agents. */
	maxAgents: Schema.natural().default(MAX_AGENTS_DEFAULT),
	/** Per-agent transcript ring cap in bytes; older output is dropped. */
	transcriptLimit: Schema.natural().default(TRANSCRIPT_LIMIT),
	/** HTTP request body cap in bytes for /agent-commander/api. */
	bodyLimit: Schema.natural().default(BODY_LIMIT),
	/** Per-frame cap in bytes for WebSocket terminal input. */
	wsInputLimit: Schema.natural().default(WS_INPUT_LIMIT),
	/** Signals allowed via the agent API / terminal WebSocket. */
	allowedSignals: Schema.array(Schema.string()).default([...ALLOWED_SIGNALS]),
	/** Role presets offered by the 新建智能体 dialog (also exposed via /api/config). */
	rolePresets: Schema.array(Schema.string()).default([...ROLE_PRESETS]),
	/** Default project root when the session has no working directory. */
	baseCwd: Schema.string().default(""),
	/** Shared-memory directory name placed under each project root. */
	memoryDir: Schema.string().default(MEMORY_DIR),
	/**
	 * 系统终端软件：auto（有 Ghostty 用 Ghostty，否则 Terminal.app）|
	 * terminal（Terminal.app）| ghostty | iterm2。智能体跑在系统终端窗口里，
	 * 不在浏览器渲染终端；会话历史管理见 docs/terminal-host-dev.md。
	 */
	terminalApp: Schema.union(["auto", "terminal", "ghostty", "iterm2"]).default("auto")
});

const MEMORY_FILES = {
	"memory.md": [
		"# Memory (记忆库)",
		"",
		"> 团队长期记忆：项目事实、决策记录、代理特长。工作经验沉淀见 experience.md。",
		"",
		"## 项目事实",
		"",
		"## 决策记录",
		"",
		"## 代理特长",
		"",
		"| 智能体 | 擅长 | 不擅长 | 最佳任务类型 |",
		"|--------|------|--------|------------|",
		""
	].join("\n"),
	"task-board.md": [
		"# Task Board (任务看板)",
		"",
		"| 任务 | 负责人 | 状态(🔄/✅/❌) | 开始时间 | 结果 |",
		"|------|--------|--------------|---------|------|",
		""
	].join("\n"),
	"experience.md": [
		"# Experience (项目经验总结)",
		"",
		"> 最后更新：YYYY-MM-DD HH:mm",
		"",
		"## 进行中的任务",
		"",
		"| 任务 | 负责智能体 | 状态 | 开始时间 | 备注 |",
		"|------|-----------|------|---------|------|",
		"",
		"## 已完成任务记录",
		"",
		"### [YYYY-MM-DD] 任务名称",
		"",
		"**目标：**",
		"",
		"**执行智能体：**",
		"",
		"**结果：**",
		"- ✅ ",
		"- ⚠️ ",
		"- ❌ ",
		"",
		"**经验教训：**",
		"- 哪里做得好，下次继续",
		"- 哪里踩了坑，下次避免",
		"- 有什么可复用的模式",
		"",
		"## 踩坑记录",
		"",
		"| 日期 | 问题 | 原因 | 解决方案 | 预防措施 |",
		"|------|------|------|---------|---------|",
		"",
		"## 复用模式库",
		"",
		"### 模式：",
		"**场景：**",
		"**做法：**",
		"**效果：**",
		""
	].join("\n")
};

/** Seed the team shared-memory files under <cwd>/<memoryDir>/ (never overwrites). */
function seedSharedMemory(cwd, memoryDir = MEMORY_DIR) {
	if (typeof cwd !== "string" || cwd === "") return;
	try {
		mkdirSync(cwd, { recursive: true });
		const memoryRoot = join(cwd, memoryDir);
		mkdirSync(memoryRoot, { recursive: true });
		mkdirSync(join(memoryRoot, "handoffs"), { recursive: true });
		for (const [fileName, content] of Object.entries(MEMORY_FILES)) {
			const filePath = join(memoryRoot, fileName);
			if (!existsSync(filePath)) writeFileSync(filePath, content, "utf8");
		}
		const usageDoc = join(memoryRoot, "MEMORY.md");
		if (!existsSync(usageDoc)) writeFileSync(usageDoc, MEMORY_USAGE_DOC, "utf8");
	} catch (error) {
		console.warn("[dsh-agent-commander] seed shared memory failed:", error?.message ?? error);
	}
}

// ---------------------------------------------------------------------------
// Cwd validation (fixes CRITICAL: path-traversal write)
// ---------------------------------------------------------------------------
/** Validate + normalize an agent working directory. Rejects empty/nonexistent dirs and paths that escape a known base. */
function validateCwd(cwd, base) {
	if (typeof cwd !== "string" || cwd === "") throw new Error("working directory is required");
	let target;
	try {
		target = isAbsolute(cwd) ? resolve(cwd) : resolve(base ?? process.cwd(), cwd);
	} catch {
		throw new Error(`invalid working directory "${cwd}"`);
	}
	if (base !== void 0) {
		const baseAbs = resolve(base);
		const rel = relative(baseAbs, target);
		if (rel === ".." || rel.startsWith(`..${sep()}`) || isAbsolute(rel)) {
			throw new Error(`working directory "${cwd}" escapes the project root "${baseAbs}"`);
		}
	}
	if (!existsSync(target) || !isDirectory(target)) throw new Error(`working directory "${target}" does not exist`);
	return target;
}
function isDirectory(p) {
	try {
		return readdirSync(p, { withFileTypes: true }) !== void 0;
	} catch {
		return false;
	}
}
function sep() {
	return "/";
}

// ---------------------------------------------------------------------------
// SQLite memory layer (node:sqlite — no native dependency). CodeGraph-inspired:
// a project knowledge base at <cwd>/.deepseek/memory.db that EVERY agent can
// read/write via the sqlite3 CLI (see .deepseek/MEMORY.md for the contract).
// ---------------------------------------------------------------------------
const MEMORY_USAGE_DOC = `# 记忆层操作手册 (SQLite)

> 团队共享记忆：所有智能体（claude / opencode / codex / DeepSeek）通过 sqlite3 CLI 读写同一个数据库。
> 工作经验沉淀见 .deepseek/experience.md。

数据库路径：\`.deepseek/memory.db\`（相对项目根目录）。sqlite3 CLI 已预装于 macOS/Linux。

---

## 文件结构

| 文件 | 用途 |
|------|------|
| \`.deepseek/memory.db\` | SQLite 知识库（机器可查询，权威来源） |
| \`.deepseek/task-board.md\` | 任务看板（人类可读视图，同步写 tasks 表） |
| \`.deepseek/experience.md\` | 经验总结（人类可读视图，同步写 memory 表） |
| \`.deepseek/handoffs/\` | 交接文件（长报告存放处，同步在 handoffs 表登记） |
| \`.deepseek/memory.md\` | 长期记忆模板（项目事实/决策/代理特长） |

---

## 数据库表结构

### memory — 知识条目

\`\`\`sql
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL DEFAULT 'general',    -- facts | decisions | experience | pitfalls | patterns
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT DEFAULT '',                          -- comma-separated
  source TEXT DEFAULT '',                        -- which agent wrote it
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
\`\`\`

### tasks — 任务跟踪

\`\`\`sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  owner TEXT DEFAULT '',
  status TEXT DEFAULT '🔄',                     -- 🔄 in-progress | ✅ done | ❌ failed | ⏸️ paused
  started_at TEXT DEFAULT (datetime('now')),
  result TEXT DEFAULT ''
);
\`\`\`

### handoffs — 跨智能体交接

\`\`\`sql
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT DEFAULT '',                     -- '' = anyone can pick up
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'open',                   -- open | picked | done
  created_at TEXT DEFAULT (datetime('now'))
);
\`\`\`

### code_links — 代码关联

\`\`\`sql
CREATE TABLE code_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT DEFAULT '',                         -- function | class | route | dep
  target TEXT DEFAULT '',
  note TEXT DEFAULT ''
);
\`\`\`

---

## 命名空间约定

| namespace | 用途 | 示例 |
|-----------|------|------|
| facts | 稳定的项目信息 | "DB 用 PostgreSQL 16" |
| decisions | 技术决策 + 理由 | "选 Redis 做缓存，因为…" |
| experience | 经验教训/最佳实践 | "并行审查比串行快 60%" |
| pitfalls | 踩坑 + 规避方案 | "node-pty 需 chmod 755" |
| patterns | 可复用模式/模板 | "多智能体并行审查模式" |

---

## 任务状态机

🔄 → ✅（完成） | 🔄 → ❌（失败） | 🔄 → ⏸️（暂停） | ⏸️ → 🔄（恢复） | ❌ → 🔄（重试）

---

## 读取操作

  # 查看最近记忆
  sqlite3 .deepseek/memory.db "SELECT id, namespace, title, substr(body,1,200) FROM memory ORDER BY id DESC LIMIT 20;"

  # 查看进行中的任务
  sqlite3 .deepseek/memory.db "SELECT * FROM tasks WHERE status = '🔄' ORDER BY id;"

  # 查看未完成的交接
  sqlite3 .deepseek/memory.db "SELECT * FROM handoffs WHERE status = 'open' ORDER BY id;"

  # 按文件查找代码关联
  sqlite3 .deepseek/memory.db "SELECT * FROM code_links WHERE file LIKE '%关键词%';"

---

## 写入操作

  # 记录新决策
  sqlite3 .deepseek/memory.db "INSERT INTO memory (namespace, title, body, tags, source) VALUES ('decisions','用 WAL 模式','SQLite 开启 WAL 提升并发读写性能','sqlite,性能','claude');"

  # 创建新任务
  sqlite3 .deepseek/memory.db "INSERT INTO tasks (title, owner, status) VALUES ('修复路径穿越','claude','🔄');"

  # 更新任务状态
  sqlite3 .deepseek/memory.db "UPDATE tasks SET status='✅', result='已修复并添加测试' WHERE id=1;"

  # 创建交接记录
  sqlite3 .deepseek/memory.db "INSERT INTO handoffs (from_agent, to_agent, subject, body) VALUES ('claude','opencode','审查报告','详见 .deepseek/handoffs/claude-review.md');"

  # 记录代码关联
  sqlite3 .deepseek/memory.db "INSERT INTO code_links (file, symbol, kind, target, note) VALUES ('plugin/lib/index.js','seedSharedMemory','function','MEMORY_FILES','记忆层播种函数');"

  # 记录经验教训
  sqlite3 .deepseek/memory.db "INSERT INTO memory (namespace, title, body, tags, source) VALUES ('experience','审查经验','并行审查比串行快 60%','审查,多智能体','claude');"

---

## 规则

1. **串行写、并行读** — SQLite 单进程写入限制：读操作可并行，写操作必须串行执行（避免 SQLITE_BUSY 锁冲突）。写入频繁时启用 WAL：sqlite3 .deepseek/memory.db "PRAGMA journal_mode=WAL;"
2. **绝不 DROP/ALTER 表** — 只允许 INSERT / UPDATE / SELECT / DELETE
3. **条目简明扼要** — 详细报告存 .deepseek/handoffs/，数据库只存摘要
4. **路径统一** — 始终使用 .deepseek/memory.db（相对项目根目录）
5. **Markdown 与 SQLite 同步** — 更新任务看板时同步更新 tasks 表，记录经验时同步写 memory 表
6. **完成任务后必做** — 更新 tasks 状态 → 写 memory 经验 → 有交付物则创建 handoffs
`;

/** Lazy node:sqlite loader (guarded — old Node without node:sqlite degrades to file memory). */
function loadSqlite() {
	try {
		return require("node:sqlite");
	} catch {
		return null;
	}
}

var MemoryStore = class {
	constructor(cwd, memoryDir = MEMORY_DIR) {
		this.root = join(cwd, memoryDir);
		this.db = null;
		this.sqlite = loadSqlite();
		if (this.sqlite === null) {
			console.warn("[dsh-agent-commander] node:sqlite unavailable — SQLite memory layer disabled");
			return;
		}
		try {
			mkdirSync(this.root, { recursive: true });
			this.db = new this.sqlite.DatabaseSync(join(this.root, "memory.db"));
			this.db.exec(`
				CREATE TABLE IF NOT EXISTS memory (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					namespace TEXT NOT NULL DEFAULT 'general',
					title TEXT NOT NULL,
					body TEXT NOT NULL,
					tags TEXT DEFAULT '',
					source TEXT DEFAULT '',
					created_at TEXT DEFAULT (datetime('now')),
					updated_at TEXT DEFAULT (datetime('now'))
				);
				CREATE TABLE IF NOT EXISTS tasks (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					title TEXT NOT NULL,
					owner TEXT DEFAULT '',
					status TEXT DEFAULT '🔄',
					started_at TEXT DEFAULT (datetime('now')),
					result TEXT DEFAULT ''
				);
				CREATE TABLE IF NOT EXISTS handoffs (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					from_agent TEXT NOT NULL,
					to_agent TEXT DEFAULT '',
					subject TEXT NOT NULL,
					body TEXT NOT NULL,
					status TEXT DEFAULT 'open',
					created_at TEXT DEFAULT (datetime('now'))
				);
				CREATE TABLE IF NOT EXISTS code_links (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					file TEXT NOT NULL,
					symbol TEXT NOT NULL,
					kind TEXT DEFAULT '',
					target TEXT DEFAULT '',
					note TEXT DEFAULT ''
				);
			`);
		} catch (error) {
			console.warn("[dsh-agent-commander] SQLite init failed:", error?.message ?? error);
			this.db = null;
		}
	}
	query(sql, params = []) {
		if (this.db === null) throw new Error("SQLite memory layer unavailable");
		return this.db.prepare(sql).all(...params);
	}
	run(sql, params = []) {
		if (this.db === null) throw new Error("SQLite memory layer unavailable");
		const res = this.db.prepare(sql).run(...params);
		return Number(res.lastInsertRowid ?? res.changes ?? 0);
	}
	addMemory({ namespace = "general", title, body, tags = "", source = "" }) {
		return this.run("INSERT INTO memory (namespace, title, body, tags, source) VALUES (?,?,?,?,?)", [namespace, title, body, tags, source]);
	}
	searchMemory(term, limit = 10) {
		const like = `%${term}%`;
		return this.query("SELECT id, namespace, title, substr(body,1,400) AS body, tags, source, created_at FROM memory WHERE body LIKE ? OR title LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT ?", [like, like, like, limit]);
	}
	listMemory(namespace, limit = 20) {
		if (namespace) return this.query("SELECT id, namespace, title, substr(body,1,400) AS body, tags, source, created_at FROM memory WHERE namespace = ? ORDER BY id DESC LIMIT ?", [namespace, limit]);
		return this.query("SELECT id, namespace, title, substr(body,1,400) AS body, tags, source, created_at FROM memory ORDER BY id DESC LIMIT ?", [limit]);
	}
	addTask({ title, owner = "", status = "🔄", result = "" }) {
		return this.run("INSERT INTO tasks (title, owner, status, result) VALUES (?,?,?,?)", [title, owner, status, result]);
	}
	updateTask(id, { status, result }) {
		this.run("UPDATE tasks SET status = ?, result = ?, started_at = started_at WHERE id = ?", [status ?? "🔄", result ?? "", id]);
	}
	listTasks(status) {
		if (status) return this.query("SELECT * FROM tasks WHERE status = ? ORDER BY id", [status]);
		return this.query("SELECT * FROM tasks ORDER BY id DESC LIMIT 50", []);
	}
	addHandoff({ fromAgent, toAgent = "", subject, body }) {
		return this.run("INSERT INTO handoffs (from_agent, to_agent, subject, body) VALUES (?,?,?,?)", [fromAgent, toAgent, subject, body]);
	}
	listHandoffs(status = "open") {
		return this.query("SELECT * FROM handoffs WHERE status = ? ORDER BY id", [status]);
	}
	addCodeLink({ file, symbol, kind = "", target = "", note = "" }) {
		return this.run("INSERT INTO code_links (file, symbol, kind, target, note) VALUES (?,?,?,?,?)", [file, symbol, kind, target, note]);
	}
	close() {
		try {
			this.db?.close();
		} catch {}
	}
};

// ---------------------------------------------------------------------------
// Status heuristics (best-effort; markers observed from claude/codex/opencode)
//
// NOTE: "⏸ manual mode on" is claude's DEFAULT footer at its idle prompt —
// it is NOT a blocked state. Spinners live in the Braille range (\u2800-\u28FF,
// opencode "⠋⠙⠹…") AND the Dingbat range (\u2700-\u27BF — claude's ✶✻✽✢),
// but the dingbat ✻ also opens the completion line "✻ Worked for Xm", so we
// key on thinking VERBS and working/idle FOOTERS instead of bare symbols.
// ---------------------------------------------------------------------------
function deriveStatus(transcript, current) {
	const clean = stripAnsi(transcript.slice(-4000));
	// WORKING: braille spinners, claude's thinking verbs, working footer.
	if (/[\u2800-\u28FF]|Thinking|Forming|Brewing|Wrangling|Boogie|working on|Reading |esc to interrupt/i.test(clean)) return "working";
	// IDLE: completion line, welcome screen, idle footer, finished.
	if (/✻ Worked|Welcome back|\? for shortcuts|❯ Try|finished/i.test(clean)) return "idle";
	return current ?? "idle";
}

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------
function registerTools(ctx, registry, storeFor, resolveCwd) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
	};
	register(defineTool({
		name: "agent_open",
		description: "Open a new team agent in the Agent Radar (right panel). Spawns a real interactive CLI process (claude / opencode / codex) in the session working directory and returns an id handle. Pass `role` to define the agent's specialty (e.g. 数据库专家, 设计专家, 代码审查专家) and `skills` to attach skill files (paths under ~/.agents/skills) the agent must read — both are injected into the agent's terminal as its opening briefing, delivered automatically once the CLI finishes booting (slow starters like opencode are waited for) and submitted with Enter so it executes as the agent's first task. The agent keeps running across turns; read output with agent_read, dispatch tasks with agent_send (submit=true to press Enter), interrupt with agent_signal (SIGINT), and close it with agent_close when done. Team protocol: every agent must read .deepseek/memory.md / .deepseek/task-board.md in the working directory, update the task board on completion, and write deliverables to .deepseek/handoffs/.",
		parameters: {
			type: {
				type: "string",
				required: true,
				description: "Agent engine: claude, opencode or codex."
			},
			name: {
				type: "string",
				description: "Team name for this agent (defaults to the engine name), e.g. \"数据库专家-张三\"."
			},
			role: {
				type: "string",
				description: "Role definition injected as the agent's briefing, e.g. \"你负责数据库设计与 SQL 优化，精通 PostgreSQL\"."
			},
			skills: {
				type: "array",
				items: { type: "string" },
				description: "Optional skill file paths under ~/.agents/skills the agent must read before working."
			},
			cwd: {
				type: "string",
				description: "Working directory (defaults to the current session cwd)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					name: { type: "string", required: true },
					type: { type: "string", required: true },
					role: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Opened agent "${value.name}" (${value.type}, id: ${value.id})${value.role ? `\n角色：${value.role}` : ""}. 已在右侧「智能体雷达」面板可见。用 agent_send 派活，agent_read 收结果。`
			}]
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = exec.agent?.session?.id;
			const cwd = sessionCwdOf(ctx, sessionId, args.cwd);
			const handle = await registry.create({
				type: args.type,
				name: args.name,
				role: args.role,
				skills: args.skills,
				cwd,
				cols: 80,
				rows: 24
			});
			return { id: handle.id, name: handle.name, type: handle.type, role: handle.role };
		}
	}));
	register(defineTool({
		name: "agent_list",
		description: "List the team agents currently open in the Agent Radar. Default scope = the CURRENT session's working directory, but if that folder has no open agents it automatically falls back to ALL open agents across every workspace — so agents created in other windows/sessions are still discoverable and operable. Each entry includes id, engine, name, role, status and working directory. Pass scope='all' to always list every open agent regardless of folder. Use this to discover agents, check who is available to take a task, and recover handles after long sequences.",
		parameters: {
			scope: {
				type: "string",
				description: "\"session\" (default) lists agents in the current session's working directory, falling back to all open agents when that folder has none; \"all\" always lists every open agent across all workspaces."
			}
		},
		output: {
			schema: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", required: true },
						type: { type: "string", required: true },
						name: { type: "string", required: true },
						role: { type: "string", required: true },
						status: { type: "string", required: true },
						exited: { type: "boolean", required: true },
						cwd: { type: "string", required: true }
					}
				}
			},
			render: (_args, value) => {
				const list = value;
				if (list.length === 0) return [{ type: "text", text: "当前没有已打开的智能体。用 agent_open 新建（claude / opencode / codex）。" }];
				return [{
					type: "text",
					text: `团队智能体（${list.length}）：\n${list.map((a) => `  ${a.id}  ${a.name} (${a.type})  [${a.status}]  ${a.cwd}${a.role ? ` — ${a.role}` : ""}`).join("\n")}`
				}];
			}
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			// Default: session folder scope, falling back to ALL workspaces so
			// agents opened from another window/session are still reachable.
			const sessionId = exec.agent?.session?.id;
			const headerCwd = sessionId === void 0 ? void 0 : ctx.sessions.get(sessionId)?.header?.cwd;
			let list;
			if (args.scope === "all" || typeof headerCwd !== "string" || headerCwd === "") {
				list = registry.list();
			} else {
				list = registry.listByCwd(headerCwd);
				if (list.length === 0) list = registry.list();
			}
			return Promise.resolve(list.map((a) => ({
				id: a.id,
				type: a.type,
				name: a.name,
				role: a.role,
				status: a.status,
				exited: a.exited,
				cwd: a.cwd
			})));
		}
	}));
	register(defineTool({
		name: "agent_read",
		description: "Read an agent's status (终端宿主模式下智能体跑在系统终端窗口，不提供实时输出；output 为空，status/exited 反映进程存活)。要了解结果请用会话历史：GET /agent-commander/api/sessions?cwd=<目录>，或直接查看系统终端窗口。",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Agent id from agent_open or agent_list."
			},
			bytes: {
				type: "integer",
				description: "Max bytes to read from the transcript tail (default 12000)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					output: { type: "string", required: true },
					truncated: { type: "boolean", required: true },
					exited: { type: "boolean", required: true },
					status: { type: "string", required: true },
					exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.truncated ? `[输出过长，仅显示末尾] ${value.output}` : value.output
			}]
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			return Promise.resolve(registry.read(args.id, args.bytes));
		}
	}));
	register(defineTool({
		name: "agent_send",
		description: "Send text to an agent's terminal (tmux send-keys semantics). To dispatch a task, pass the task description and submit=true (appends Enter — do NOT put \\n in the text yourself). Instructions should be concrete: 输入（读什么文件/数据）、动作（做什么）、输出（期望的汇报格式）。To send Ctrl+C use agent_signal with signal=\"SIGINT\", not control characters. This tool does NOT wait for completion — poll with agent_read.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Agent id."
			},
			text: {
				type: "string",
				required: true,
				description: "UTF-8 text to write to the agent's stdin (no trailing newline)."
			},
			submit: {
				type: "boolean",
				description: "Append an Enter key after the text (default false). Set true when dispatching a command or task."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					submitted: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `已发送给智能体 ${value.id}${value.submitted ? "（并回车提交）" : ""}。用 agent_read 观察输出。` }]
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			await registry.send(args.id, args.text, args.submit === true);
			return { id: args.id, submitted: args.submit === true };
		}
	}));
	register(defineTool({
		name: "agent_broadcast",
		description: "Dispatch the SAME task to MULTIPLE team agents in parallel — the coordination primitive for running one mission across several agents (e.g. 让 claude code 和 opencode 各自用可用工具/MCP 分析同一项目). Every listed agent receives the text on its terminal and it is submitted with Enter (回车执行). Returns per-agent delivery status; poll each agent's result with agent_read. Agents keep working independently afterwards.",
		parameters: {
			ids: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Agent ids to receive the task (from agent_list)."
			},
			text: {
				type: "string",
				required: true,
				description: "Task text sent to every listed agent (no newlines; submit presses Enter)."
			},
			submit: {
				type: "boolean",
				description: "Press Enter after writing the text (default true)."
			}
		},
		output: {
			schema: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", required: true },
						name: { type: "string", required: true },
						sent: { type: "boolean", required: true },
						error: { oneOf: [{ type: "string" }, { type: "null" }] }
					}
				}
			},
			render: (_args, value) => {
				if (value.length === 0) return [{ type: "text", text: "没有可派发的智能体（ids 为空）。" }];
				return [{
					type: "text",
					text: `已向 ${value.length} 个智能体并行派发任务：\n${value.map((r) => `  ${r.id}  ${r.name}  ${r.sent ? "✓ 已发送并回车执行" : `✗ ${r.error ?? "发送失败"}`}`).join("\n")}\n用 agent_read 逐个收集结果。`
				}];
			}
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			const ids = Array.isArray(args.ids) ? args.ids.filter((s) => typeof s === "string" && s !== "") : [];
			const submit = args.submit !== false;
			const results = [];
			for (const id of ids) {
				try {
					await registry.send(id, String(args.text ?? ""), submit);
					const handle = registry.get(id);
					results.push({ id, name: handle?.name ?? id, sent: true, error: null });
				} catch (error) {
					results.push({ id, name: id, sent: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return results;
		}
	}));
	register(defineTool({
		name: "agent_signal",
		description: "Send a signal to an agent's process: SIGINT (Ctrl+C, interrupt the running task), SIGTSTP (Ctrl+Z, suspend) or SIGTERM. Use SIGINT when an agent is stuck or running too long; the agent usually recovers to its prompt and can receive a new task.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Agent id."
			},
			signal: {
				type: "string",
				required: true,
				description: "Signal name: SIGINT, SIGTSTP or SIGTERM."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					signal: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `已向智能体 ${value.id} 发送 ${value.signal}。` }]
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			await registry.signal(args.id, args.signal);
			return { id: args.id, signal: args.signal };
		}
	}));
	register(defineTool({
		name: "agent_close",
		description: "Close an agent: kills its process and removes it from the Agent Radar. Use when the agent's work is done and you no longer need it. (Closing does NOT delete the agent's files or task-board entries.)",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Agent id."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					closed: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `智能体 ${value.id} 已关闭。` }]
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			await registry.close(args.id);
			return { id: args.id, closed: true };
		}
	}));
	register(defineTool({
		name: "agent_approve",
		description: "Click-confirm a prompt inside an agent's terminal — sends the given choice (default '1' = Yes) and presses Enter. Use when an agent is waiting for a permission/approval dialog (e.g. 'This command requires approval' with Yes/No options, or claude's folder-trust prompt).",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Agent id."
			},
			choice: {
				type: "string",
				description: "Choice to send (default '1' = first option / Yes)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					choice: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `已向智能体 ${value.id} 发送确认「${value.choice}」并回车。` }]
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			await registry.approve(args.id, args.choice);
			return { id: args.id, choice: args.choice ?? "1" };
		}
	}));
	register(defineTool({
		name: "agent_compact",
		description: "Compact an agent's current session context — reduces token usage by summarizing without clearing history. Use when an agent's context is getting long and you want to free up tokens. Supports: claude (/compact), codebuddy (/compact), qwen (/compact).",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Agent id."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", required: true },
					compacted: { type: "boolean", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `已向智能体 ${value.id} 发送压缩会话命令。` }]
		},
		execute: async (args, exec) => {
			exec.signal.throwIfAborted();
			await registry.compactSession(args.id);
			return { id: args.id, compacted: true };
		}
	}));
	register(defineTool({
		name: "mem_query",
		description: "Query the team's SQLite knowledge base (.deepseek/memory.db) — the shared memory layer every agent reads/writes. Returns matching memory entries (experience/facts/decisions/pitfalls). Use before starting a task to recall what the team already learned.",
		parameters: {
			query: {
				type: "string",
				description: "Search keyword(s) to match against memory titles/bodies/tags."
			},
			namespace: {
				type: "string",
				description: "Optional namespace filter: facts / decisions / experience / pitfalls / patterns."
			},
			limit: {
				type: "integer",
				description: "Max entries (default 10)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					entries: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "integer", required: true },
								namespace: { type: "string", required: true },
								title: { type: "string", required: true },
								body: { type: "string", required: true },
								tags: { type: "string", required: true },
								source: { type: "string", required: true },
								created_at: { type: "string", required: true }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const list = value.entries;
				if (list.length === 0) return [{ type: "text", text: "记忆库中没有匹配条目。" }];
				return [{ type: "text", text: `记忆库命中 ${list.length} 条：\n${list.map((e) => `  [${e.namespace}] ${e.title}（${e.source}，${e.created_at}）\n    ${e.body}`).join("\n")}` }];
			}
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const store = storeFor(resolveCwd(exec.agent?.session?.id));
			if (args.query && String(args.query).trim() !== "") return Promise.resolve({ entries: store.searchMemory(String(args.query), args.limit ?? 10) });
			return Promise.resolve({ entries: store.listMemory(args.namespace, args.limit ?? 10) });
		}
	}));
	register(defineTool({
		name: "mem_add",
		description: "Write an entry into the team's SQLite knowledge base (.deepseek/memory.db) — the shared memory layer every agent reads/writes. Use after finishing work or learning something: namespace 'experience' (结果/教训), 'facts' (项目事实), 'decisions', 'pitfalls' (踩坑), 'patterns' (复用模式).",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Short title."
			},
			body: {
				type: "string",
				required: true,
				description: "Content (keep concise; long reports go to .deepseek/handoffs/)."
			},
			namespace: {
				type: "string",
				description: "Namespace: experience / facts / decisions / pitfalls / patterns (default experience)."
			},
			tags: {
				type: "string",
				description: "Comma-separated tags."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "integer", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: `已写入记忆库（id ${value.id}）。` }]
		},
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const store = storeFor(resolveCwd(exec.agent?.session?.id));
			const id = store.addMemory({
				namespace: args.namespace ?? "experience",
				title: String(args.title),
				body: String(args.body),
				tags: String(args.tags ?? ""),
				source: "deepseek"
			});
			return Promise.resolve({ id });
		}
	}));
	return () => {
		for (const dispose of disposers) dispose();
	};
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
function registerApi(ctx, registry, storeFor, fence, resolveCwd, cfg = {}, scanner = null) {
	const bodyLimit = Number.isFinite(cfg.bodyLimit) && cfg.bodyLimit > 0 ? cfg.bodyLimit : BODY_LIMIT;
	const rb = (req) => readBody(req, bodyLimit);
	const handler = async (req, res) => {
		if (!fence(req)) {
			writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
			return;
		}
		const url = new URL(req.url ?? "/", "http://dsh.internal");
		const path = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "") || "/";
		const memoryStore = (cwd) => storeFor(cwd ?? url.searchParams.get("cwd") ?? void 0);
		try {
			// Sanitized runtime config — powers the client (role presets, engine
			// list, limits) and lets other plugins inspect the active settings.
			if (req.method === "GET" && path === "/config") {
				writeOk(res, { config: {
					maxAgents: registry.maxAgents,
					transcriptLimit: registry.transcriptLimit,
					bodyLimit,
					wsInputLimit: Number.isFinite(cfg.wsInputLimit) && cfg.wsInputLimit > 0 ? cfg.wsInputLimit : WS_INPUT_LIMIT,
					allowedSignals: registry.allowedSignals,
					rolePresets: Array.isArray(cfg.rolePresets) && cfg.rolePresets.length > 0 ? cfg.rolePresets : [...ROLE_PRESETS],
					baseCwd: registry.baseCwd,
					memoryDir: registry.memoryDir,
					agentTypes: ENGINE_TYPES,
					terminalApp: cfg.terminalApp ?? "auto",
					apiPrefix: API_PREFIX,
					wsList: WS_LIST
				} });
				return;
			}
			if (req.method === "GET" && path === "/terminal/status") {
				writeOk(res, {
					app: registry.launcher?.resolveApp?.() ?? "terminal",
					label: registry.launcher?.label ?? "Terminal.app",
					apps: TerminalLauncher.detectAll(),
					engines: ENGINE_TYPES.map((e) => ({ id: e, installed: registry.binaries?.[e] != null }))
				});
				return;
			}
			// 会话历史（cc-switch 式）：列出 / 恢复 / 删除
			if (req.method === "GET" && path === "/sessions") {
				const cwd = url.searchParams.get("cwd") ?? "";
				const sessions = cwd !== "" ? await scanner.list(cwd) : [];
				// 标记运行中：精确匹配运行 handle 的 sessionId；否则该引擎+cwd 有
				// 运行 handle 且是此引擎在该目录的最新会话（新建会话的近似）。
				const running = registry.runningSessionKeys();
				for (const s of sessions) {
					const r = running.get(`${s.engine}:${cwd}`);
					s.running = false;
					if (r === void 0) continue;
					const isLatest = sessions.filter((x) => x.engine === s.engine).findIndex((x) => x.id === s.id) === 0;
					if (r.sessionId === s.id || isLatest) {
						s.running = true;
						s.runningAgent = r; // { agentId, name, pid, sessionId, status, createdAt }
					}
				}
				writeOk(res, { sessions });
				return;
			}
			if (req.method === "POST" && path === "/sessions/restore") {
				const body = await rb(req);
				const cwd = sessionCwdOf(ctx, body.sessionId, body.cwd);
				const handle = await registry.restoreSession({ engine: String(body.engine ?? ""), sessionId: String(body.id ?? ""), cwd, name: body.name });
				writeOk(res, { agent: registry.meta(handle) });
				return;
			}
			const sessionDelete = path.match(/^\/sessions\/([a-z]+)\/([^/]+)$/);
			if (req.method === "DELETE" && sessionDelete !== null) {
				const engine = decodeURIComponent(sessionDelete[1]);
				const id = decodeURIComponent(sessionDelete[2]);
				const cwd = sessionCwdOf(ctx, undefined, url.searchParams.get("cwd") ?? "");
				await scanner.deleteSession(engine, id, cwd);
				writeOk(res, { engine, id, deleted: true });
				return;
			}
			if (req.method === "GET" && path === "/agents") {
				const cwd = url.searchParams.get("cwd") ?? "";
				writeOk(res, { agents: cwd !== "" ? registry.listByCwd(cwd) : registry.list() });
				return;
			}
			if (req.method === "POST" && path === "/agents/scan") {
				const body = await rb(req);
				const cwd = sessionCwdOf(ctx, body.sessionId, body.cwd);
				writeOk(res, registry.scanCwd(cwd));
				return;
			}
			// Re-spawn one saved agent of a folder (ghost "恢复" button).
			const restoreMatch = path.match(/^\/agents\/([^/]+)\/restore$/);
			if (restoreMatch !== null && req.method === "POST") {
				const body = await rb(req);
				const cwd = sessionCwdOf(ctx, body.sessionId, body.cwd);
				writeOk(res, { agent: registry.restoreSaved(cwd, restoreMatch[1]) });
				return;
			}
			// Forget (delete) one saved agent record of a folder (ghost "✕" button).
			const forgetMatch = path.match(/^\/agents\/([^/]+)\/forget$/);
			if (forgetMatch !== null && req.method === "POST") {
				const body = await rb(req);
				const cwd = sessionCwdOf(ctx, body.sessionId, body.cwd);
				writeOk(res, registry.forgetSaved(cwd, forgetMatch[1]));
				return;
			}
			if (req.method === "GET" && path === "/binaries") {
				writeOk(res, { binaries: detectBinaries() });
				return;
			}
			if (req.method === "GET" && path === "/skills") {
				writeOk(res, { skills: listSkills() });
				return;
			}
			if (req.method === "POST" && path === "/agents") {
				const body = await rb(req);
				const cwd = sessionCwdOf(ctx, body.sessionId, body.cwd);
				const handle = await registry.create({
					type: String(body.type ?? ""),
					name: body.name,
					role: body.role,
					skills: body.skills,
					cwd,
					cols: body.cols ?? 80,
					rows: body.rows ?? 24,
					sessionId: body.sessionId,
					sessionName: body.sessionName,
					workspaceId: body.workspaceId
				});
				writeOk(res, { agent: registry.meta(handle) });
				return;
			}
			if (req.method === "DELETE" && path.startsWith("/agents/")) {
				const id = path.slice("/agents/".length);
				const graceful = url.searchParams.get("graceful") === "1";
				await registry.close(id, graceful);
				writeOk(res, { id, closed: true, graceful });
				return;
			}
			// Standard agent methods: send / read / approve / signal / status / new-session
			const agentMatch = path.match(/^\/agents\/([^/]+)\/(send|read|approve|signal|status|new-session|compact)$/);
			if (agentMatch !== null) {
				const [, id, op] = agentMatch;
				if (op === "send" && req.method === "POST") {
					const body = await rb(req);
					await registry.send(id, String(body.text ?? ""), body.submit === true);
					writeOk(res, { id, submitted: body.submit === true });
					return;
				}
				if (op === "read" && req.method === "GET") {
					const bytes = Number(url.searchParams.get("bytes") ?? 12000);
					writeOk(res, await registry.read(id, Number.isFinite(bytes) ? bytes : 12000));
					return;
				}
				if (op === "approve" && req.method === "POST") {
					const body = await rb(req);
					await registry.approve(id, body.choice === void 0 ? "1" : String(body.choice));
					writeOk(res, { id, choice: body.choice === void 0 ? "1" : String(body.choice) });
					return;
				}
				if (op === "signal" && req.method === "POST") {
					const body = await rb(req);
					await registry.signal(id, String(body.signal ?? ""));
					writeOk(res, { id, signal: body.signal });
					return;
				}
				if (op === "new-session" && req.method === "POST") {
					await registry.newSession(id);
					writeOk(res, { id, newSession: true });
					return;
				}
				if (op === "compact" && req.method === "POST") {
					await registry.compactSession(id);
					writeOk(res, { id, compacted: true });
					return;
				}
				if (op === "status" && req.method === "GET") {
					const handle = registry.get(id);
					if (handle === void 0) throw new Error(`agent "${id}" not found`);
					writeOk(res, registry.meta(handle));
					return;
				}
			}
			// Memory endpoints (SQLite knowledge base)
			if (req.method === "GET" && path === "/memory") {
				const ns = url.searchParams.get("namespace") ?? "";
				writeOk(res, { entries: memoryStore().listMemory(ns || undefined) });
				return;
			}
			if (req.method === "GET" && path === "/memory/search") {
				const term = url.searchParams.get("q") ?? "";
				writeOk(res, { entries: memoryStore().searchMemory(term) });
				return;
			}
			if (req.method === "POST" && path === "/memory") {
				const body = await rb(req);
				const id = memoryStore().addMemory({
					namespace: body.namespace ?? "general",
					title: String(body.title ?? ""),
					body: String(body.body ?? ""),
					tags: String(body.tags ?? ""),
					source: String(body.source ?? "")
				});
				writeOk(res, { id });
				return;
			}
			if (req.method === "GET" && path === "/tasks") {
				writeOk(res, { tasks: memoryStore().listTasks(url.searchParams.get("status") ?? undefined) });
				return;
			}
			// Cache introspection / one-click compression
			if (req.method === "GET" && path === "/cache") {
				writeOk(res, { agents: registry.allCacheInfo() });
				return;
			}
			if (req.method === "POST" && path === "/cache/compress") {
				const body = await rb(req);
				const id = body?.id;
				const results = id
					? [await registry.compressCache(registry.get(id)?.type ?? "", registry.get(id)?.cwd ?? "")]
					: await Promise.all([...registry.agents.values()].map((h) => registry.compressCache(h.type, h.cwd)));
				writeOk(res, { results });
				return;
			}
			writeJson(res, 404, { ok: false, error: { code: "not-found", message: `no route ${req.method} ${path}` } });
		} catch (error) {
			writeError(res, error);
		}
	};
	return ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler
	}), "dsh-agent-commander: api route");
}

// ---------------------------------------------------------------------------
// WebSocket routes
// ---------------------------------------------------------------------------
function registerWebsockets(ctx, registry, fence) {
	const { WebSocketServer } = getWs();
	const listWss = new WebSocketServer({ noServer: true });
	// 终端模式：不再有终端 WS（浏览器不渲染终端）；只有列表 WS 推送运行中
	// 智能体状态（2s 进程存活轮询 → 状态变化时推送）。
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: WS_LIST,
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			listWss.handleUpgrade(req, socket, head, (ws) => attachList(registry, ws, req));
		}
	}), "dsh-agent-commander: list WebSocket");
	ctx.effect(() => () => {
		listWss.close();
	}, "dsh-agent-commander: websocket teardown");
}

function attachList(registry, ws, req) {
	// Optional ?cwd= scope: when the radar connects for a specific workspace
	// folder, only push agents that belong to that folder (listByCwd).
	let cwd = void 0;
	try {
		cwd = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("cwd") ?? void 0;
	} catch {}
	const { WebSocket } = getWs();
	const send = () => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(cwd !== void 0 && cwd !== "" ? registry.listByCwd(cwd) : registry.list()));
		}
	};
	send();
	const unsubscribe = registry.subscribe(send);
	ws.on("close", () => unsubscribe());
	ws.on("error", () => unsubscribe());
}


// ---------------------------------------------------------------------------
// Plugin body — standard cordis Service class form.
//
// Per the official DSH plugin standard, plugins that provide capabilities to
// OTHER plugins use the Service class form: `new Service(ctx, name)` registers
// the instance under `name` in the current context, so another plugin can
// simply declare `inject: ['agentCommander']` and use ctx.agentCommander.
// ---------------------------------------------------------------------------
export class AgentCommanderService extends Service {
	constructor(ctx, config = {}) {
		super(ctx, "agentCommander");
		// The agent-commander skill rides inside this bundle; make it available
		// to ~/.agents/skills so the model picks it up (best-effort, no-clobber).
		ensureBundledSkillInstalled();
		// Mount into the framework (official plugin mechanism): contribute a
		// global system-prompt section so EVERY conversation — new windows and
		// fresh sessions included — knows the team-agent capability exists and
		// how to discover/operate the agents. Without this the model only sees
		// bare tool schemas and never learns the workflow (reported: 新对话里
		// 不知道怎么找到智能体、怎么操作智能体). The registration is auto-disposed
		// when the plugin unloads, per the Cordis lifecycle.
		try {
			ctx.systemPrompt.section({
				name: "dsh-agent-commander:team",
				order: 150,
				text: [
					"团队智能体（Agent Radar）：",
					"右侧「智能体雷达」面板管理系统终端窗口里的真实智能体（claude / opencode / codex / codebuddy）：",
					"1. 先用 agent_list 查看已打开（运行中）的智能体（含 id、引擎、状态、工作目录）；agent_open 会在系统终端里开新窗口启动智能体并注入角色/技能简报。",
					"2. 会话历史（cc-switch 式）：GET /agent-commander/api/sessions?cwd=<目录> 可列出本工作区四引擎的历史会话（时间/ID/标题/token），POST /sessions/restore 恢复、DELETE /sessions/:engine/:id 删除。",
					"3. agent_send 派发任务（submit=true 回车；经系统按键注入，需辅助功能权限）；agent_broadcast 并行派发；agent_read 在终端模式下不提供实时输出（系统终端无 pty），结果以会话历史为准。",
					"4. agent_approve 确认权限提问；agent_signal 发中断（kill）；agent_close 关闭（SIGTERM→SIGKILL）。",
					"5. 团队共享记忆：项目 .deepseek/ 下 memory.md、task-board.md、experience.md、handoffs/ 与 SQLite 记忆库 memory.db；智能体开工先读、完成后回写。"
				].join("\n")
			});
		} catch {}
		// Normalize the validated config (the loader already filled schema
		// defaults, but the class must stay robust when driven directly).
		this.cfg = {
			maxAgents: Number.isFinite(config.maxAgents) && config.maxAgents > 0 ? config.maxAgents : MAX_AGENTS_DEFAULT,
			transcriptLimit: Number.isFinite(config.transcriptLimit) && config.transcriptLimit > 0 ? config.transcriptLimit : TRANSCRIPT_LIMIT,
			bodyLimit: Number.isFinite(config.bodyLimit) && config.bodyLimit > 0 ? config.bodyLimit : BODY_LIMIT,
			wsInputLimit: Number.isFinite(config.wsInputLimit) && config.wsInputLimit > 0 ? config.wsInputLimit : WS_INPUT_LIMIT,
			allowedSignals: Array.isArray(config.allowedSignals) && config.allowedSignals.length > 0 ? config.allowedSignals : [...ALLOWED_SIGNALS],
			rolePresets: Array.isArray(config.rolePresets) && config.rolePresets.length > 0 ? config.rolePresets : [...ROLE_PRESETS],
			baseCwd: typeof config.baseCwd === "string" && config.baseCwd !== "" ? config.baseCwd : process.cwd(),
			memoryDir: typeof config.memoryDir === "string" && config.memoryDir !== "" ? config.memoryDir : MEMORY_DIR,
			terminalApp: ["terminal", "ghostty", "iterm2"].includes(config.terminalApp) ? config.terminalApp : "auto"
		};
		this.baseCwd = this.cfg.baseCwd;
		this.memoryDir = this.cfg.memoryDir;
		// 终端宿主：智能体跑在系统终端窗口里（Terminal/Ghostty/iTerm），
		// 不在浏览器渲染；会话历史管理见 session-scanner。
		this.scanner = new SessionScanner();
		this.terminalApp = this.cfg.terminalApp;
		this.terminalLabel = new TerminalLauncher(this.cfg.terminalApp).label;
		// 项目根目录 = 创建智能体时所在会话的工作目录。所有智能体配置收拢到
		// 项目根 <memoryDir>/agents.json（即使智能体 cwd 是子目录），保证配置
		// 都在用户所指的项目根目录下。
		this.projectRootOf = (handle) => {
			const sessionId = handle?.sessionId;
			if (typeof sessionId === "string" && sessionId !== "") {
				try {
					const headerCwd = ctx.sessions.get(sessionId)?.header?.cwd;
					if (typeof headerCwd === "string" && headerCwd !== "") return headerCwd;
				} catch {}
			}
			return handle?.cwd ?? this.baseCwd;
		};
		// Per-project memory stores: one SQLite knowledge base per working
		// directory, so the plugin tools and the agents read/write the SAME
		// <memoryDir>/memory.db of whichever project they operate in.
		this.stores = new Map();
		this.baseStore = new MemoryStore(this.baseCwd, this.memoryDir);
		this.stores.set(this.baseCwd, this.baseStore);
		this.registry = new TerminalAgentRegistry({
			maxAgents: this.cfg.maxAgents,
			transcriptLimit: this.cfg.transcriptLimit,
			allowedSignals: this.cfg.allowedSignals,
			memoryDir: this.memoryDir,
			baseCwd: this.baseCwd,
			terminalApp: this.cfg.terminalApp,
			onSpawn: (cwd) => {
				try {
					seedSharedMemory(cwd, this.memoryDir);
				} catch {}
			}
		});
		ctx.logger?.info?.(`[dsh-agent-commander] agent host = 系统终端（${this.terminalLabel}）`);
		const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);
		const resolveCwd = (sessionId) => sessionCwdOf(ctx, sessionId);
		registerApi(ctx, this.registry, (cwd) => this.storeFor(cwd), fence, resolveCwd, this.cfg, this.scanner);
		registerWebsockets(ctx, this.registry, fence, this.cfg);
		let toolsDisposers = null;
		toolsDisposers = registerTools(ctx, this.registry, (cwd) => this.storeFor(cwd), resolveCwd);
		ctx.effect(() => () => {
			toolsDisposers?.();
			this.registry.shutdown();
			for (const store of this.stores.values()) store.close();
		}, "dsh-agent-commander: teardown");
	}
	/** Get (or create) the SQLite memory store for a project directory. */
	storeFor(cwd) {
		const key = typeof cwd === "string" && cwd !== "" ? cwd : this.baseCwd;
		let store = this.stores.get(key);
		if (store === void 0) {
			store = new MemoryStore(key, this.memoryDir);
			this.stores.set(key, store);
		}
		return store;
	}

	// ---- Standard public API surface (for other plugins / scripts) ----
	/** List every open agent (metas). */
	list() {
		return this.registry.list();
	}
	/** Open a new agent; returns its meta. */
	async open(opts) {
		const handle = await this.registry.create(opts);
		return this.registry.meta(handle);
	}
	/** Send text to an agent (submit=true presses Enter). */
	async send(id, text, submit) {
		await this.registry.send(id, text, submit === true);
		return { id };
	}
	/** Read an agent's recent output (ANSI-stripped). */
	async read(id, bytes) {
		return this.registry.read(id, bytes);
	}
	/** Click-confirm a prompt (default choice "1" = Yes). */
	async approve(id, choice) {
		await this.registry.approve(id, choice);
		return { id };
	}
	/** Send a whitelisted signal (SIGINT/SIGTSTP/SIGTERM). */
	async signal(id, signal) {
		await this.registry.signal(id, signal);
		return { id };
	}
	/** Close an agent (graceful = ask it to /exit first). */
	async close(id, graceful) {
		await this.registry.close(id, graceful === true);
		return { id };
	}
	/** Get one agent's live status/meta (null when unknown). */
	status(id) {
		const handle = this.registry.get(id);
		return handle === void 0 ? null : this.registry.meta(handle);
	}
	/** 会话历史（cc-switch 式）：列出某工作目录的全部会话。 */
	sessions(cwd) {
		return this.scanner.list(cwd);
	}
	/** 恢复一个历史会话（拉起系统终端）。 */
	restoreSession(opts) {
		return this.registry.restoreSession(opts);
	}
	/** 删除一个历史会话。 */
	deleteSession(engine, id, cwd) {
		return this.scanner.deleteSession(engine, id, cwd);
	}
	/** 终端软件信息。 */
	terminalStatus() {
		return {
			app: this.registry.launcher?.resolveApp?.() ?? "terminal",
			label: this.registry.launcher?.label ?? "Terminal.app",
			apps: TerminalLauncher.detectAll(),
			engines: ENGINE_TYPES.map((e) => ({ id: e, installed: this.registry.binaries?.[e] != null }))
		};
	}
	/** SQLite memory layer access (shared knowledge base, routed per project cwd). */
	memory = {
		query: (term, limit, cwd) => this.storeFor(cwd).searchMemory(term, limit ?? 10),
		add: (entry, cwd) => ({ id: this.storeFor(cwd).addMemory(entry) }),
		list: (namespace, limit, cwd) => this.storeFor(cwd).listMemory(namespace, limit)
	};
	/** Raw config snapshot (normalized; matches the fields of the exported Config schema). */
	get config() {
		return {
			maxAgents: this.registry.maxAgents,
			transcriptLimit: this.registry.transcriptLimit,
			bodyLimit: this.cfg.bodyLimit,
			wsInputLimit: this.cfg.wsInputLimit,
			allowedSignals: this.registry.allowedSignals,
			rolePresets: this.cfg.rolePresets,
			baseCwd: this.baseCwd,
			memoryDir: this.memoryDir,
			terminalApp: this.cfg.terminalApp,
			terminalLabel: this.terminalLabel
		};
	}
}

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-agent-commander";
/** Services required before mounting. */
export const inject = ["webServer", "sessions", "webRuntime", "tools", "systemPrompt"];

/**
 * Standard plugin entry: function form delegating to the Service class.
 * `config` is validated + defaulted by the exported `Config` schema — the
 * loader fills in defaults, so unknown fields fail loudly at mount time
 * instead of being silently ignored.
 */
export function apply(ctx, config = {}) {
	return new AgentCommanderService(ctx, config);
}
