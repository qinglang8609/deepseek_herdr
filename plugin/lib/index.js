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
import { execFileSync } from "node:child_process";
import { existsSync, chmodSync, readdirSync, writeFileSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, isAbsolute, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionScanner } from "./session-scanner.js";
import { SessionMonitor, buildSessionList, MONITOR_INTERVAL_MS } from "./session-monitor.js";

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
// ---------------------------------------------------------------------------
// Harness runtime packages — @deepseek-ai/dsh-tools, @deepseek-ai/cordis and
// @deepseek-ai/schemastery are ESM-only and are NOT part of this plugin's own
// dependency tree. When the plugin is installed as a pnpm `link:` (symlink →
// this checkout), Node resolves the entry from its realpath, so bare imports
// would miss the profile's node_modules — exactly the failure mode that
// `fallbackRequire` above already handles for `ws` / `node-pty`.
//
// createRequire().resolve() only LOCATES the entry file (it never executes the
// module, so it works for ESM-only packages on any Node), and then import() of
// the absolute path loads it without any node_modules walk. Top-level await
// keeps the rest of the module body (Config, Service subclass) running in the
// normal synchronous order — the cordis loader awaits the entry import anyway.
// ---------------------------------------------------------------------------
function resolveFromAnchors(spec) {
	const anchors = moduleAnchors();
	let lastError = null;
	for (const anchor of anchors) {
		try {
			return createRequire(anchor).resolve(spec);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error(`cannot resolve "${spec}" from any module anchor`);
}
const { defineTool } = await import(pathToFileURL(resolveFromAnchors("@deepseek-ai/dsh-tools")).href);
const { Service } = await import(pathToFileURL(resolveFromAnchors("@deepseek-ai/cordis")).href);
const { default: Schema } = await import(pathToFileURL(resolveFromAnchors("@deepseek-ai/schemastery")).href);
/** Lazy `ws` — resolved through the anchor chain so terminal WebSockets work no matter how the plugin was installed. */
let wsModule = null;
function getWs() {
	if (wsModule === null) wsModule = fallbackRequire("ws");
	return wsModule;
}

const API_PREFIX = "/agent-commander/api";
const WS_TERMINAL = "/agent-commander/ws/terminal";
const WS_LIST = "/agent-commander/ws/list";
const WS_SESSIONS = "/agent-commander/ws/sessions";
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
// Prompts to auto-answer, grouped per engine. `keys` is the keystroke sequence
// (last element is the Enter submit); kind="critical" (real y/n permission gate)
// is NOT auto-answered — it surfaces to the user via pendingApproval. Matching is
// engine-scoped (a phrase meant for claude isn't auto-answered for codex) and
// anchored to the RECENT transcript tail, so an early boot echo doesn't re-trigger.
// `once: true` = one-shot Enter/menu (never re-answer same sig); absent = y/n,
// re-answered only after MONITOR_ANSWER_REPEAT_MS.
const PER_ENGINE_PROMPTS = {
	claude: [
		{ re: /Entertoconfirm·Esctocancel|Quicksafetycheck/, keys: ["\r"], kind: "auto", once: true },
		{ re: /Doyoutrustthefilesinthisfolder/, keys: ["\r"], kind: "auto", once: true },
		{ re: /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No/, kind: "critical" },
		{ re: /PressEnterto|Entertoselect|Selectanoption/, keys: ["\r"], kind: "auto", once: true }
	],
	codex: [
		{ re: /1\.Yes,Itrustthisfolder/, keys: ["1", "\r"], kind: "auto", once: true },
		{ re: /Doyoutrustthefilesinthisfolder/, keys: ["y", "\r"], kind: "auto", once: true },
		{ re: /Howdoyouwanttoproceed|Selectanoption|Entertoselect/, keys: ["\r"], kind: "auto", once: true },
		{ re: /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No/, kind: "critical" }
	],
	codebuddy: [
		{ re: /Doyoutrustthefilesinthisfolder|Entertoconfirm·Esctocancel|Quicksafetycheck/, keys: ["\r"], kind: "auto", once: true },
		{ re: /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No/, kind: "critical" }
	],
	// opencode 的提示由其专用 db 校验路径处理，不在此自动答。
	opencode: [],
	// 未单独列出的引擎回退到通用组。
	default: [
		{ re: /Doyoutrustthefilesinthisfolder/, keys: ["\r"], kind: "auto", once: true },
		{ re: /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No/, kind: "critical" },
		{ re: /PressEnterto|Entertoselect|Selectanoption|Entertoconfirm·Esctocancel|Quicksafetycheck/, keys: ["\r"], kind: "auto", once: true }
	]
};
// Per-engine "CLI is ready to accept the briefing" marker. Only include engines
// with a verified, unambiguous prompt glyph; others fall through to the generic
// quiet heuristic (a bare ">" / "❯" would false-positive on ordinary output).
const PER_ENGINE_READY_RE = {
	opencode: /Askanything|escinterrupt|tabagents|ctrl\+p/,
	claude: /\?forshortcuts|←foragents|❯Try|Welcomeback|Doyouwanttotrust/
};
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
/** Resume a saved session per engine: returns the CLI args array given a session id. */
const RESUME_COMMANDS = {
	claude: () => [],
	codebuddy: (id) => ["--resume", String(id)],
	qwen: (id) => ["--resume", String(id)],
	opencode: (id) => ["-s", String(id)],
	codex: (id) => ["resume", String(id)],
	pi: (id) => ["--resume", String(id)]
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

/** PID 是否真实存活（用于「运行中」判定：残留 handle 不会误标）。 */
function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
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
function loadNodePty() {
	try {
		return require("node-pty");
	} catch (error) {
		try {
			// Installed as link/tarball/git — the plugin's own node_modules may be
			// absent; fall back to the Harness profile module mirror.
			return fallbackRequire("node-pty");
		} catch {
			console.warn("[dsh-agent-commander] node-pty failed to load:", error?.message ?? error);
			return null;
		}
	}
}
function ensureSpawnHelper() {
	if (process.platform === "win32") return;
	try {
		const entry = require.resolve("node-pty");
		const packageRoot = dirname(dirname(entry));
		const candidates = [];
		const prebuilds = join(packageRoot, "prebuilds");
		try {
			for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir, "spawn-helper"));
		} catch {}
		candidates.push(join(packageRoot, "build", "Release", "spawn-helper"));
		for (const helper of candidates) if (existsSync(helper)) chmodSync(helper, 0o755);
	} catch {}
}

// ---------------------------------------------------------------------------
// Binary resolution for agent CLIs
// ---------------------------------------------------------------------------
function nvmNodeBins() {
	// nvm-managed Node global bins: codebuddy/cbc are typically installed via
	// `npm i -g @tencent-ai/codebuddy-code`, which puts them in
	// ~/.nvm/versions/node/<version>/bin. The desktop host runs with a stripped
	// PATH so those dirs are only reachable through an explicit glob.
	const bins = [];
	try {
		const root = join(homedir(), ".nvm", "versions", "node");
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const bin = join(root, entry.name, "bin");
			if (existsSync(bin)) bins.push(bin);
		}
	} catch {}
	return bins;
}
function searchPathDirs() {
	const dirs = [];
	const pathEntries = (process.env.PATH ?? "").split(":");
	for (const dir of pathEntries) if (dir !== "" && !dirs.includes(dir)) dirs.push(dir);
	// Common agent CLI install dirs beyond PATH: ~/.local/bin (claude/codex),
	// ~/.opencode/bin (opencode), homebrew, /usr/local.
	for (const extra of [join(homedir(), ".local", "bin"), join(homedir(), ".opencode", "bin"), join(homedir(), ".claude", "local"), join(homedir(), ".codebuddy", "bin"), join(homedir(), ".pi", "bin"), join(homedir(), ".qwen", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) if (!dirs.includes(extra)) dirs.push(extra);
	// nvm node bins (codebuddy/cbc) — see nvmNodeBins().
	for (const nodeBin of nvmNodeBins()) if (!dirs.includes(nodeBin)) dirs.push(nodeBin);
	// Tencent WorkBuddy desktop bundle ships a `codebuddy` CLI at this path.
	for (const extra of ["/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin"]) if (!dirs.includes(extra)) dirs.push(extra);
	return dirs;
}
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
	/** 会话历史定时巡检间隔（毫秒）。0 = 关闭定时巡检，仅靠订阅首帧 + 手动刷新。 */
	monitorIntervalMs: Schema.natural().default(MONITOR_INTERVAL_MS)
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
var AgentRegistry = class {
	constructor(nodePty, maxAgents, baseCwd, onSpawn, projectRootOf, opts = {}) {
		this.nodePty = nodePty;
		this.maxAgents = maxAgents;
		this.baseCwd = baseCwd ?? process.cwd();
		this.onSpawn = typeof onSpawn === "function" ? onSpawn : null;
		this.projectRootOf = typeof projectRootOf === "function" ? projectRootOf : null;
		// Configurable limits (config → apply → constructor).
		this.transcriptLimit = Number.isFinite(opts.transcriptLimit) && opts.transcriptLimit > 0 ? opts.transcriptLimit : TRANSCRIPT_LIMIT;
		this.allowedSignals = Array.isArray(opts.allowedSignals) && opts.allowedSignals.length > 0 ? opts.allowedSignals : [...ALLOWED_SIGNALS];
		this.memoryDir = typeof opts.memoryDir === "string" && opts.memoryDir !== "" ? opts.memoryDir : MEMORY_DIR;
		this.agents = new Map();
		this.listeners = new Set();
		this.statusTimer = null;
		this.statusSweepTimer = setInterval(() => this.statusSweep(), 5000);
		// True while restoreState/scanCwd are re-spawning saved agents: persist()
		// must NOT delete the agents.json of a root it hasn't finished restoring
		// yet (the file is the only record of those agents).
		this.restoring = false;
		// True during app teardown: the first persist() in shutdown() already
		// wrote the live config, so the exit events fired by killing the PTYs
		// must not make persist() delete that just-written config.
		this.shuttingDown = false;
	}
	/** Debounced notify: status flips (idle↔working) are coalesced to one push per 1.5s. */
	scheduleStatusNotify() {
		if (this.statusTimer !== null) return;
		this.statusTimer = setTimeout(() => {
			this.statusTimer = null;
			this.notify();
		}, 1500);
	}
	/**
	 * Periodic sweep: re-evaluate agents stuck at "working" that have not
	 * produced output for STATUS_IDLE_AFTER_MS. The Braille spinner and
	 * thinking-verb check (STATUS_ACTIVE_RE) covers opencode, claude, and
	 * future engines — if the last 4000 bytes of transcript contain no active
	 * indicator and enough time has passed, the agent is demoted to "idle".
	 */
	statusSweep() {
		const now = Date.now();
		for (const handle of this.agents.values()) {
			if (handle.status !== "working" || handle.exited) continue;
			const lastAt = handle.lastOutputAt ?? handle.updatedAt ?? 0;
			if (now - lastAt < STATUS_IDLE_AFTER_MS) continue;
			const tail = stripAnsi(handle.transcript.slice(-4000));
			if (STATUS_ACTIVE_RE.test(tail)) continue;
			handle.status = "idle";
			this.scheduleStatusNotify();
		}
	}
	create({ type, name, role, skills, cwd, cols, rows, id, sessionId, sessionName, workspaceId, restored }) {
		if (this.agents.size >= this.maxAgents) throw new Error(`agent limit reached (${this.maxAgents})`);
		if (!AGENT_TYPES.includes(type)) throw new Error(`unknown agent type "${type}" — allowed: ${AGENT_TYPES.join(", ")}`);
		const binary = resolveBinary(type);
		if (binary === null) throw new Error(`agent type "${type}" is not installed`);
		const targetCwd = validateCwd(cwd, this.baseCwd);
		if (type === "codex") this.ensureCodexTrust(targetCwd); // codex ≥0.151 folder-trust gate
		seedSharedMemory(targetCwd, this.memoryDir);
		if (this.onSpawn !== null) {
			try {
				this.onSpawn(targetCwd);
			} catch {}
		}
		const agentId = typeof id === "string" && id !== "" ? id : randomUUID().slice(0, 8);
		const trimmedRole = (role ?? "").trim();
		const skillList = Array.isArray(skills) ? skills.filter((s) => typeof s === "string") : [];
		const spawnCols = Math.max(2, Math.floor(cols ?? 80));
		const spawnRows = Math.max(2, Math.floor(rows ?? 24));
		const handle = {
			id: agentId,
			type,
			name: (name ?? type).trim() || type,
			role: trimmedRole,
			skills: skillList,
			cwd: targetCwd,
			_cols: spawnCols,
			_rows: spawnRows,
			sessionId: typeof sessionId === "string" ? sessionId : "",
			// 引擎会话缓存 ID（claude jsonl / codex rollout / opencode db 的会话 id）。
			// 与上面的 sessionId（创建时所在的 DSH 会话 id，供 projectRootOf 定位项目根）
			// 语义不同：runningSessions ↔ buildSessionList 的「运行中」绑定只用这个。
			// 新建时未知（引擎在首条消息后才落盘会话文件），由 _discoverSessionId 补齐。
			sessionCacheId: void 0,
			sessionName: typeof sessionName === "string" ? sessionName : "",
			workspaceId: typeof workspaceId === "string" ? workspaceId : "",
			restored: restored === true,
			pid: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			// 简报恒注入（用户反馈：空角色新建后什么都没注入，agent 没有团队上下文）。
			// 角色为空时 briefingText 落到团队协议兜底文案；恢复的已保存智能体同样
			// 注入 —— 重启后它开的是全新对话，正需要这段简报找回角色。
			briefing: "pending",
			exited: false,
			exitCode: null,
			status: "idle",
			transcript: "",
			pendingApproval: void 0,
			pty: this.nodePty.spawn(binary, [], {
				name: "xterm-256color",
				cols: spawnCols,
				rows: spawnRows,
				cwd: targetCwd,
				env: this.agentEnv(targetCwd)
			})
		};
		handle.pid = handle.pty.pid;
		this._attachPty(handle);
		this.agents.set(agentId, handle);
		// Startup monitor: watch boot, auto-answer prompts (folder trust, y/n),
		// inject the briefing and submit it with Enter once the CLI has formally
		// entered its UI, and keep answering until the first task completes.
		this.startMonitor(handle, handle.briefing === "pending");
		this.notify();
		this.persist();
		return handle;
	}
	/** Wire the live pty of an agent to its transcript/status and exit handling.
	 * Shared by create() and _respawn() so both get identical lifecycle hooks.
	 * On a boot-phase crash (briefing still pending, no retry yet) we auto-respawn
	 * once, preserving the pending briefing/role/skills, so the "agent dies at
	 * startup/approval" case recovers instead of leaving a dead card. */
	_attachPty(handle) {
		handle.pty.onData((data) => {
			handle.transcript += data;
			if (handle.transcript.length > this.transcriptLimit) handle.transcript = handle.transcript.slice(handle.transcript.length - this.transcriptLimit);
			handle.updatedAt = Date.now();
			handle.lastOutputAt = Date.now();
			const next = deriveStatus(handle.transcript, handle.status);
			if (next !== handle.status) {
				handle.status = next;
				this.scheduleStatusNotify();
			}
		});
		handle.pty.onExit(({ exitCode }) => {
			clearTimeout(handle._monitorTimer);
			handle.exited = true;
			handle.exitCode = exitCode;
			handle.status = "exited";
			handle.updatedAt = Date.now();
			// 启动期退出：把最近输出存为 bootError，让面板能直接看到「为什么秒退」。
			if (handle._monitor?.phase === "boot") {
				const tail = stripAnsi(handle.transcript).slice(-200).trim();
				if (tail !== "") handle.bootError = tail;
			}
			// 退出时把最近输出的尾巴打到调试日志，便于真机排查「秒退/启动即退」的真正原因。
			this._monLog(handle, `exit code=${exitCode} tail="${stripAnsi(handle.transcript).slice(-160)}"`);
			const m = handle._monitor;
			// 仅当「真的在启动进程」时自动重开：有输出（非秒退）且不在用户主动关闭（phase=exit 已排除）。
			const actuallyBooted = handle.transcript.length > 0;
			const bootCrash = m !== void 0 && m.phase === "boot" && !m.reacted && handle.briefing === "pending" && handle._respawned !== true && actuallyBooted;
			if (bootCrash) {
				handle._respawned = true;
				this._monLog(handle, `boot crash (exit=${exitCode}) → auto-respawn`);
				try {
					this._respawn(handle);
				} catch (e) {
					console.warn("[dsh-agent-commander] respawn failed:", e?.message ?? e);
					this.notify();
					this.persist();
				}
				return;
			}
			this.notify();
			this.persist();
		});
	}
	/** Lightweight restart of an agent's pty (fresh conversation), re-running the
	 * startup monitor with the same briefing intent. Used once after a boot crash. */
	_respawn(handle) {
		try {
			handle.pty?.kill();
		} catch {}
		const binary = resolveBinary(handle.type);
		if (binary === null) {
			handle.exited = true;
			handle.status = "exited";
			this.notify();
			this.persist();
			return;
		}
		const inject = handle._monitor?.inject === true;
		// 重开是全新对话：清空转录与会话缓存，简报按原 intent 重注入。
		handle.exited = false;
		handle.exitCode = null;
		handle.status = "idle";
		handle.pendingApproval = void 0;
		handle.transcript = "";
		handle.sessionCacheId = void 0;
		handle.pty = this.nodePty.spawn(binary, [], {
			name: "xterm-256color",
			cols: handle._cols ?? 80,
			rows: handle._rows ?? 24,
			cwd: handle.cwd,
			env: this.agentEnv(handle.cwd)
		});
		handle.pid = handle.pty.pid;
		this._attachPty(handle);
		this.startMonitor(handle, inject);
		this.notify();
		this.persist();
	}
	/** Debug log for the startup monitor. Opt-in via DSH_AGENT_MONITOR_DEBUG=1 so
	 * it doesn't spam normal operation, but makes real-machine issues diagnosable
	 * from the host log when enabled. */
	_monLog(handle, msg) {
		if (process.env.DSH_AGENT_MONITOR_DEBUG !== "1") return;
		console.warn(`[dsh-agent-commander][monitor] ${handle?.id ?? "?"} ${msg}`);
	}
	/** Minimal env for spawned agents — whitelist only; never leak harness secrets (fixes MEDIUM env leak). */
	agentEnv(cwd) {
		const env = { PATH: enhancedPath(), TERM: "xterm-256color", PWD: cwd };
		for (const key of AGENT_ENV_KEYS) {
			const value = process.env[key];
			if (typeof value === "string") env[key] = value;
		}
		return env;
	}
	/**
	 * codex ≥0.151 gates loading project-local config/hooks/exec policies behind a
	 * folder-trust prompt (only the EXACT cwd is honored — a trusted parent is not
	 * enough). Spawned interactively by node-pty, codex renders that as a full-screen
	 * TUI; the monitor neither fingerprints it as a y/n nor pauses the briefing, so a
	 * stray Enter/briefing lands on its prompt and codex aborts. The robust fix is to
	 * pre-trust the spawn cwd: ensure `~/.codex/config.toml` has
	 * `[projects."<cwd>"] trust_level = "trusted"`. Idempotent + safe: only appends when
	 * the exact dir isn't already listed, never rewrites an existing project entry, and
	 * makes a one-time backup before the first edit. Returns true if the config now
	 * trusts the dir (or already did).
	 */
	ensureCodexTrust(cwd) {
		if (typeof cwd !== "string" || cwd === "") return false;
		try {
			const configPath = join(homedir(), ".codex", "config.toml");
			if (!existsSync(configPath)) return false;
			const quoted = '"' + String(cwd).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
			const header = `[projects.${quoted}]`;
			const original = readFileSync(configPath, "utf8");
			// Already listed? Respect an existing entry either way — never override a
			// user's explicit choice, and never duplicate the table.
			if (original.includes(header)) return true;
			// Back up the user's config only the first time we modify it.
			const bak = configPath + ".dshbak";
			if (!existsSync(bak)) writeFileSync(bak, original, "utf8");
			const block = `\n\n# added by dsh-agent-commander (auto-trust so codex boots without the folder-trust prompt)\n${header}\ntrust_level = "trusted"\n`;
			writeFileSync(configPath, original + (original.endsWith("\n") ? "" : "\n") + block, "utf8");
			return true;
		} catch (error) {
			console.warn("[dsh-agent-commander] codex trust ensure failed:", error?.message ?? error);
			return false;
		}
	}
	/**
	 * Start the lifecycle monitor for a freshly spawned agent. `inject` is true
	 * when a role/skill briefing must be delivered as the agent's first task
	 * (false for restored agents — their saved conversation already contains it,
	 * but the monitor still auto-answers any boot prompts such as login).
	 */
	startMonitor(handle, inject) {
		const m = handle._monitor = {
			phase: "boot",          // boot → inject → verify → done; "exit" on close
			startedAt: Date.now(),
			inject: inject === true,
			injected: false,
			injectAt: 0,
			enterDue: 0,
			enters: 0,
			rewrites: 0,            // full-briefing rewrites after swallowed text
			baseline: 0,            // transcript length at the last Enter press
			reacted: false,         // saw the agent actually react to the briefing
			answered: []            // [{ sig, at }] — prompts already answered
		};
		if (inject) handle.briefing = "pending";
		this._monLog(handle, `start monitor (engine=${handle.type}, inject=${inject})`);
		handle._monitorTimer = setTimeout(() => this.monitorTick(handle), MONITOR_POLL_MS);
	}
	/**
	 * One monitor tick: auto-answer prompts, inject + submit the briefing once
	 * the CLI has formally entered its UI, retry Enter until the agent reacts,
	 * and finish after the first task completes (activity, then output quiet).
	 */
	monitorTick(handle) {
		const m = handle._monitor;
		if (handle.exited || m === void 0 || m.phase === "done" || m.phase === "exit") return;
		const now = Date.now();
		const elapsed = now - m.startedAt;
		const clean = stripAnsi(handle.transcript.slice(-4000));
		const norm = clean.replace(/\s+/g, "");

		// 1) Auto-answer interactive prompts (boot questions + first-task prompts).
		this.answerPrompts(handle, clean, norm, now);

		// 2) Inject the briefing once the CLI is ready (or at the boot cap).
		if (!m.injected && m.inject && m.phase === "boot") {
			// opencode boots slowly (spawning MCP servers, loading plugins) and
			// swallows input written before it settles — so its cap is much
			// longer and only a backstop; delivery is verified below.
			const cap = handle.type === "opencode" ? MONITOR_OPENCODE_CAP_MS : MONITOR_CAP_MS;
			if (this.cliReady(handle, clean, norm, elapsed) || elapsed >= cap) {
				this.injectBriefing(handle, m);
			}
		}

		// 3) Delivery + verification loop.
		if (m.injected && !m.reacted) {
			if (handle.type === "opencode") {
				// opencode's TUI does NOT echo accepted input to the PTY output
				// stream, so transcript growth can't prove delivery — and it
				// swallows text written mid-boot (MCP/plugin loading). Verify
				// against opencode's OWN session db that the briefing landed as
				// a user message; if not, re-write the full text + Enter (a bare
				// Enter would submit an empty line) and keep polling until
				// confirmed, attempts exhausted, or the total cap.
				if (now >= m.ocVerifyAt) {
					if (this.opencodeBriefingLanded(handle, m.injectAt - 5000)) {
						m.reacted = true;
						this.markBriefingSent(handle);
					} else if (m.ocAttempts < MONITOR_OPENCODE_MAX_INJECTS && elapsed < MONITOR_TOTAL_CAP_MS) {
						m.ocAttempts += 1;
						m.ocVerifyAt = now + MONITOR_OPENCODE_VERIFY_MS;
						this.writeBriefing(handle, m);
					} else {
						// keep verifying (a late landing still counts) — no more writes
						m.ocVerifyAt = now + MONITOR_OPENCODE_VERIFY_MS;
					}
				}
			} else if (m.enters > 0 && (handle.transcript.length > m.baseline + 512 || this._briefingLandedInFile(handle, m.injectAt - 5000))) {
				// Reacted = the CLI produced new output after Enter (an accepted
				// submit redraws/clears the input line and starts the task; a
				// swallowed Enter leaves the transcript untouched) — OR the
				// briefing is verifiably a user message in the engine's own
				// session file (claude/codebuddy jsonl, codex rollout). The file
				// check is authoritative: it also proves the conversation exists,
				// so the session-history card can appear and be bound to this
				// window (会话历史 ↔ 窗口绑定).
				m.reacted = true;
				if (!handle.sessionCacheId) {
					const found = this._latestSessionFile(handle, m.injectAt - 5000);
					if (found !== null && !this._claimedSessionIds(handle).has(found.id)) handle.sessionCacheId = found.id;
				}
				this.markBriefingSent(handle);
			}
		}
		// Enter retry for engines whose text is already sitting on the input line.
		// Enters exhausted without a verified landing → the text was likely
		// swallowed mid-boot: rewrite the FULL briefing and restart the Enter
		// cycle (same discipline as the opencode verify loop), bounded.
		if (handle.type !== "opencode" && m.injected && !m.reacted && now >= m.enterDue) {
			if (m.enters < MONITOR_MAX_ENTERS) {
				this.pressEnter(handle, m);
			} else if ((m.rewrites ?? 0) < 2 && elapsed < MONITOR_TOTAL_CAP_MS) {
				m.rewrites = (m.rewrites ?? 0) + 1;
				m.enters = 0;
				try {
					handle.pty.write(this.briefingText(handle));
				} catch {}
				m.enterDue = Date.now() + MONITOR_ENTER_DELAY;
			}
		}

		// 4) First task done = reaction seen, then output quiet for a while.
		if (m.injected && m.reacted && m.phase === "boot") {
			const quietMs = Date.now() - (handle.lastOutputAt ?? now);
			// 关键 yes/no 待确认：不推进到任务态，继续轮询等用户决定。
			if (handle.pendingApproval !== void 0) {
				handle._monitorTimer = setTimeout(() => this.monitorTick(handle), MONITOR_POLL_MS);
				return;
			}
			if (quietMs >= MONITOR_TASK_QUIET_MS || elapsed >= MONITOR_TOTAL_CAP_MS) {
				this.finishMonitor(handle, m, m.reacted ? "sent" : "failed");
				return;
			}
		}

		// 5) Hard caps: restored / no-briefing agents only need the boot window.
		const cap = m.inject ? MONITOR_TOTAL_CAP_MS : MONITOR_CAP_MS;
		if (elapsed >= cap) {
			// 待确认时不受总时限约束，等用户回应后再收尾；避免用户还没点就被收走。
			if (handle.pendingApproval !== void 0) {
				handle._monitorTimer = setTimeout(() => this.monitorTick(handle), MONITOR_POLL_MS);
				return;
			}
			const state = m.inject ? (m.injected ? (m.reacted ? "sent" : "failed") : "failed") : "none";
			this.finishMonitor(handle, m, state);
			return;
		}

		handle._monitorTimer = setTimeout(() => this.monitorTick(handle), MONITOR_POLL_MS);
	}
	/**
	 * Auto-answer one interactive prompt per tick. Signatures prevent answering
	 * the same persistent on-screen question twice within MONITOR_ANSWER_REPEAT_MS.
	 */
	answerPrompts(handle, clean, norm, now) {
		// Only auto-answer during the boot phase to limit prompt injection surface.
		// Once the monitor transitions to task phase, the agent handles its own prompts.
		const m = handle._monitor;
		if (m.phase !== "boot") return;
		// 引擎白名单：只对「该引擎确认为安全」的启动提示自动答；未单列的引擎回退通用组。
		const prompts = PER_ENGINE_PROMPTS[handle.type] ?? PER_ENGINE_PROMPTS.default;
		// 只匹配最近一段转录尾，避免把启动早期回显/已答过的提示再次误答（锚定到近端）。
		const recent = norm.slice(-600);
		for (const pattern of prompts) {
			const match = pattern.re.exec(recent);
			if (match === null) continue;
			const sig = `${pattern.re.source}:${String(match[0] ?? "").slice(0, 40)}`;
			// Menus (Enter-confirm) are one-shot — the prompt text stays in the
			// accumulated transcript, so only skip re-answering y/n prompts
			// within the repeat window; a NEW y/n prompt of the same kind (e.g.
			// several "Do you want to proceed?" permission gates) is re-answered.
			const last = m.answered.find((a) => a.sig === sig);
			if (last !== void 0 && (pattern.once === true || now - last.at < MONITOR_ANSWER_REPEAT_MS)) continue;
			// critical：真正的 y/n 权限门 → 不自动点，挂起为「待确认」上报用户决定。
			if (pattern.kind === "critical") {
				if (handle.pendingApproval === void 0) {
					handle.pendingApproval = {
						sig,
						prompt: String(match[0] ?? "").slice(0, 80) || "是否继续？",
						engine: handle.type,
						agentId: handle.id,
						at: now,
						answered: false,
						answerType: "yes_no"
					};
					this.notify();
				}
				handle.lastOutputAt = Date.now();
				return; // 等待用户决定，不自动答
			}
			const keys = pattern.keys ?? ["\r"];
			m.answered.push({ sig, at: pattern.once === true ? Infinity : now });
			if (m.answered.length > 40) m.answered.shift();
			this._monLog(handle, `answer prompt keys=${JSON.stringify(keys)} sig=${sig}`);
			try {
				const lastIx = keys.length - 1;
				for (let i = 0; i < keys.length; i++) {
					const k = keys[i];
					if (i === lastIx) {
						setTimeout(() => {
							try {
								handle.pty.write(k);
							} catch {}
						}, 200);
					} else {
						try {
							handle.pty.write(k);
						} catch {}
					}
				}
			} catch {}
			// The answer will produce output; never inject right on top of it.
			handle.lastOutputAt = Date.now();
			return; // one answer per tick — re-evaluate next poll
		}
	}
	/**
	 * Is the CLI formally ready to accept the briefing? Quiet after a boot grace
	 * is the generic signal (TUIs only go quiet once they settle at the prompt);
	 * per-engine markers catch CLIs whose footer keeps animating.
	 */
	cliReady(handle, clean, norm, elapsed) {
		if (elapsed < MONITOR_BOOT_GRACE) return false;
		// 有挂起的确认（权限/信任门）→ 绝不在此时注入简报，避免把简报打进确认提示。
		if (handle.pendingApproval !== void 0) return false;
		// 引擎专属「可注入」标记：opencode/claude 需等到真实提示符再注入，否则会吞掉简报。
		const readyRe = PER_ENGINE_READY_RE[handle.type];
		if (readyRe !== void 0 && readyRe.test(norm)) return true;
		// opencode 的 TUI 在恢复会话时会持续重绘，「静默」不可靠，必须等真实提示符。
		if (handle.type === "opencode") return false;
		// 其余引擎：启动宽限期后静默即视为就绪。
		return Date.now() - (handle.lastOutputAt ?? Date.now()) >= MONITOR_QUIET_MS;
	}
	/**
	 * Write the role/skill briefing as the agent's first task. opencode's input
	 * box is single-line — the TUI drops embedded newlines, so join with spaces
	 * there; other engines accept multi-line input. The Enter submit happens in
	 * monitorTick (two-phase: text now, Enter at MONITOR_ENTER_DELAY).
	 */
	briefingText(handle) {
		const lines = [
			`[dsh-agent-commander] 你已被总指挥以「${handle.name}」的身份启动（引擎：${handle.type}）。`,
			`职责定义：${handle.role !== "" ? handle.role : "（本次未指定具体职责：请先读取团队记忆了解上下文，然后待命等待总指挥派活。）"}`,
			"团队协作协议（必须遵守）：",
			"1. 先读取工作目录 .deepseek/ 下的 memory.md、task-board.md、experience.md 和 MEMORY.md，了解团队上下文、进行中的任务、历史经验与 SQLite 记忆层用法。",
			"2. 完成任务后，在 .deepseek/task-board.md 和 SQLite 的 tasks 表中把对应任务状态更新为 ✅/❌ 并写明结果。",
			"3. 重要产出写入 .deepseek/handoffs/（文件名建议 .deepseek/handoffs/<你的名字>-<主题>.md），并在 handoffs 表登记。",
			"4. 工作结束后，在 .deepseek/experience.md 和 SQLite memory 表（namespace='experience'）中沉淀经验：结果、经验教训、踩坑记录、可复用的模式。",
			"5. 向总指挥（DeepSeek）汇报：做了什么、结果如何、下一步建议。"
		];
		for (const skill of handle.skills) lines.push(`请先阅读并遵循技能文件：${skill}`);
		return handle.type === "opencode" ? lines.join(" ") : lines.join("\n");
	}
	injectBriefing(handle, m) {
		if (handle.exited) return;
		m.injected = true;
		m.injectAt = Date.now();
		m.enters = 0;
		m.reacted = false;
		m.enterDue = m.injectAt + MONITOR_ENTER_DELAY;
		this._monLog(handle, "inject briefing (submit scheduled)");
		if (handle.type === "opencode") {
			m.ocAttempts = 0;
			m.ocVerifyAt = m.injectAt + MONITOR_OPENCODE_VERIFY_MS;
			this.writeBriefing(handle, m);
		} else {
			try {
				handle.pty.write(this.briefingText(handle));
			} catch {}
		}
	}
	/**
	 * opencode: write the briefing text and submit it with Enter after the
	 * usual delay. Used for both the initial inject and every verification
	 * retry — opencode swallows text written mid-boot, so retrying the full
	 * text (not just Enter) is what eventually lands it.
	 */
	writeBriefing(handle, m) {
		try {
			handle.pty.write(this.briefingText(handle));
		} catch {}
		m.baseline = handle.transcript.length;
		setTimeout(() => {
			try {
				handle.pty.write("\r");
			} catch {}
		}, MONITOR_ENTER_DELAY);
	}
	/** Path to opencode's global session db (null when opencode hasn't run yet). */
	opencodeDbPath() {
		try {
			const p = join(homedir(), ".local", "share", "opencode", "opencode.db");
			return existsSync(p) ? p : null;
		} catch {
			return null;
		}
	}
	/**
	 * Did the briefing text land as a user message in opencode's session db?
	 * Looks for a part containing the briefing marker in any session rooted at
	 * the agent's cwd, created after the injection moment. Read-only; the
	 * caller throttles calls to this (once per MONITOR_OPENCODE_VERIFY_MS).
	 */
	opencodeBriefingLanded(handle, sinceMs) {
		try {
			const dbPath = this.opencodeDbPath();
			if (dbPath === null) return false;
			const sqlite = loadSqlite();
			if (sqlite === null) return false;
			// Plain open (SELECTs only): avoids `readOnly` which older Node's
			// node:sqlite doesn't support, and a shared read connection is safe
			// against opencode's own WAL connection.
			const db = new sqlite.DatabaseSync(dbPath);
			try {
				const row = db.prepare(
					`SELECT 1 AS hit FROM session s
					 WHERE s.directory = ?
					   AND EXISTS (
					     SELECT 1 FROM part p
					     WHERE p.session_id = s.id
					       AND p.time_created >= ?
					       AND p.data LIKE '%你已被总指挥以「%'
					   )
					 LIMIT 1`
				).get(resolve(handle.cwd), sinceMs);
				return row !== undefined;
			} finally {
				db.close();
			}
		} catch {
			return false;
		}
	}
	/** Press Enter on the agent's terminal (submits whatever is on the input line). */
	pressEnter(handle, m) {
		if (handle.exited) return;
		m.enters += 1;
		m.baseline = handle.transcript.length;
		m.enterDue = Date.now() + MONITOR_ENTER_RETRY_MS;
		this._monLog(handle, `press enter #${m.enters}`);
		try {
			handle.pty.write("\r");
		} catch {}
	}
	/** End the monitor; `briefing` state is reported to the radar panel. */
	finishMonitor(handle, m, state) {
		m.phase = "done";
		handle.briefing = state;
		handle.updatedAt = Date.now();
		this._monLog(handle, `finish monitor → ${state}`);
		this.notify();
		// Keep .deepseek/agents.json in sync: without this it stays at the
		// creation-time "pending" snapshot forever even after the briefing was
		// delivered ("sent") or failed.
		this.persist();
	}
	/**
	 * Flip the briefing to "sent" the moment delivery is *verified*, not after
	 * the task goes quiet. Previously the monitor only reported "sent" once the
	 * first task produced MONITOR_TASK_QUIET_MS of silence or hit the total cap
	 * (5 min) — an agent that keeps working after accepting the briefing never
	 * goes quiet, so the radar panel stayed on 「简报注入中…」 the whole time even
	 * though the briefing had long since landed. This is idempotent: it does not
	 * touch the monitor phase, so the lifecycle still finishes normally.
	 */
	markBriefingSent(handle) {
		if (handle.briefing === "sent") return; // 幂等
		handle.briefing = "sent";
		handle.bootError = void 0; // 简报已着陆说明启动成功，清除启动期报错提示
		handle.updatedAt = Date.now();
		this.notify();
		this.persist();
	}
	meta(handle) {
		return {
			id: handle.id,
			type: handle.type,
			name: handle.name,
			role: handle.role,
			skills: handle.skills,
			cwd: handle.cwd,
			status: handle.status,
			exited: handle.exited,
			exitCode: handle.exitCode,
			pid: handle.pid,
			sessionId: handle.sessionId,
			sessionCacheId: handle.sessionCacheId ?? null,
			sessionName: handle.sessionName,
			workspaceId: handle.workspaceId,
			restored: handle.restored === true,
			briefing: handle.briefing ?? "none",
			pendingApproval: handle.pendingApproval ?? null,
			bootError: handle.bootError ?? null,
			createdAt: handle.createdAt,
			updatedAt: handle.updatedAt
		};
	}
	list() {
		return [...this.agents.values()].map((handle) => this.meta(handle));
	}
	/** Workspace-scoped view: agents whose working directory IS this folder or
	 * lives under it. Used by the radar panel / agent_list after a workspace
	 * switch, so each folder only sees its own agents. */
	listByCwd(cwd) {
		const target = typeof cwd === "string" && cwd !== "" ? resolve(cwd) : this.baseCwd;
		return [...this.agents.values()]
			.filter((handle) => handle.cwd === target || handle.cwd.startsWith(target + sep()))
			.map((handle) => this.meta(handle));
	}
	get(id) {
		return this.agents.get(id);
	}
	/** 会话历史（buildSessionList）需要：返回当前运行中的智能体行（node-pty 下直接来自 agents Map）。 */
	/** 运行中的窗口（node-pty 下即 agents Map 里进程真实存活的 handle）。 */
	runningSessions() {
		const out = [];
		for (const h of this.agents.values()) {
			if (h.exited === true || h.status === "exited" || h.pty === null || h.pty === void 0 || !isPidAlive(h.pid)) continue;
			// 绑定用的是「引擎会话缓存 ID」（会话文件 id），不是创建时的 DSH 会话 id：
			// 未知的在此按（引擎+cwd+创建时间）发现补齐 —— 见 _discoverSessionId。
			if (!h.sessionCacheId) this._discoverSessionId(h);
			out.push({
				agentId: h.id,
				name: h.name,
				type: h.type,
				cwd: h.cwd,
				pid: h.pid,
				sessionId: h.sessionCacheId ?? "",
				status: h.status,
				createdAt: h.createdAt,
				updatedAt: h.updatedAt
			});
		}
		return out;
	}
	/** 其他运行窗口已占用的会话缓存 ID 集合（同一引擎同目录开两个窗口时不互抢会话）。 */
	_claimedSessionIds(self) {
		const claimed = new Set();
		for (const o of this.agents.values()) {
			if (o === self || !o.sessionCacheId) continue;
			claimed.add(o.sessionCacheId);
		}
		return claimed;
	}
	/** 引擎会话目录（claude/codebuddy 的 projects/<slug>；codex 的 sessions 树）。 */
	_sessionDirOf(type, cwd) {
		if (type === "claude") return join(homedir(), ".claude", "projects", String(cwd ?? "").replace(/[^a-zA-Z0-9]+/g, "-"));
		if (type === "codebuddy") return join(homedir(), ".codebuddy", "projects", String(cwd ?? "").replace(/^\/+/, "").replace(/[^a-zA-Z0-9_]+/g, "-"));
		if (type === "codex") return join(homedir(), ".codex", "sessions");
		return null; // opencode 走 sqlite db
	}
	/**
	 * 找该窗口「出生之后」新落盘的引擎会话文件（{ path, id } | null）。
	 * claude/codebuddy：projects/<slug>/ 下 mtime >= bornAfter 的最新 .jsonl；
	 * codex：sessions 树里 session_meta.cwd 匹配的最新 rollout-*.jsonl。
	 * 引擎在首条消息后才写会话文件 —— 所以新建窗口初始拿不到，随轮询补齐。
	 */
	_latestSessionFile(handle, bornAfter) {
		const dir = this._sessionDirOf(handle.type, handle.cwd);
		if (dir === null || handle.type === "codex") {
			if (handle.type !== "codex") return null;
			let best = null;
			const walk = (d) => {
				let entries = [];
				try {
					entries = readdirSync(d, { withFileTypes: true });
				} catch {
					return;
				}
				for (const e of entries) {
					const p = join(d, e.name);
					if (e.isDirectory()) {
						walk(p);
					} else if (e.name.endsWith(".jsonl")) {
						try {
							const st = statOf(p);
							if (st === null || st.mtimeMs < bornAfter) continue;
							const first = readFileSync(p, "utf8").split("\n").find((l) => l.includes("session_meta"));
							const meta = first ? JSON.parse(first).payload ?? {} : {};
							if (meta.cwd !== handle.cwd) continue;
							const id = meta.session_id ?? "";
							if (id === "") continue;
							if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, id, mtimeMs: st.mtimeMs };
						} catch {}
					}
				}
			};
			walk(dir);
			return best;
		}
		let best = null;
		try {
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".jsonl")) continue;
				const full = join(dir, f);
				const st = statOf(full);
				if (st === null || st.mtimeMs < bornAfter) continue;
				if (best === null || st.mtimeMs > best.mtimeMs) best = { path: full, id: f.replace(/\.jsonl$/, ""), mtimeMs: st.mtimeMs };
			}
		} catch {}
		return best;
	}
	/**
	 * 为运行窗口发现并绑定真实的引擎会话 ID（会话缓存 ID）。
	 * 只认 handle.createdAt 之后新落盘的会话文件 —— 绝不会把更早的空闲历史会话
	 * 误标成运行中（保留「精确命中」原则，同时让命中真正可能发生）。
	 * opencode 没有会话文件，改查它自己的 session db。
	 */
	_discoverSessionId(handle) {
		const now = Date.now();
		if ((handle._sessionScanAt ?? 0) > now - 1500) return; // 节流：1.5s 一次
		handle._sessionScanAt = now;
		const claimed = this._claimedSessionIds(handle);
		if (handle.type === "opencode") {
			try {
				const db = join(homedir(), ".local", "share", "opencode", "opencode.db");
				if (!existsSync(db)) return;
				const esc = String(handle.cwd ?? "").replace(/'/g, "''");
				const id = execFileSync("/usr/bin/sqlite3", [db, `SELECT id FROM session WHERE directory='${esc}' AND time_archived IS NULL AND time_created >= ${Math.floor((handle.createdAt ?? 0) - 5000)} ORDER BY time_created DESC LIMIT 1;`], { timeout: 5000 }).toString().trim();
				if (id !== "" && !claimed.has(id)) handle.sessionCacheId = id;
			} catch {}
			return;
		}
		const found = this._latestSessionFile(handle, (handle.createdAt ?? 0) - 5000);
		if (found !== null && !claimed.has(found.id)) handle.sessionCacheId = found.id;
	}
	/** 简报是否已落进引擎会话文件（= 对话已开始、会话卡片有了数据源）。 */
	_briefingLandedInFile(handle, sinceMs) {
		try {
			const found = this._latestSessionFile(handle, sinceMs);
			if (found === null) return false;
			return readFileSync(found.path, "utf8").slice(-131072).includes("[dsh-agent-commander]");
		} catch {
			return false;
		}
	}
	/** 会话巡检需要：node-pty 下所有运行窗口本来就在 agents Map，无需接管别的宿主 → 空操作。 */
	syncPaneAgents(_cwd) { /* noop */ }
	/** 恢复一个历史会话：node-pty 执行引擎 resume 命令。返回新 handle。 */
	async restoreSession({ engine, sessionId: sid, cwd, name }) {
		const binary = resolveBinary(engine);
		if (binary === null) throw new Error(`引擎 "${engine}" 未安装`);
		const targetCwd = typeof cwd === "string" && cwd !== "" ? cwd : this.baseCwd;
		if (engine === "codex") this.ensureCodexTrust(targetCwd);
		const args = RESUME_COMMANDS[engine]?.(sid) ?? [ "--resume", String(sid) ];
		const agentId = randomUUID().slice(0, 8);
		const handle = {
			id: agentId,
			type: engine,
			name: typeof name === "string" && name !== "" ? name : `${engine}-resume`,
			role: "",
			skills: [],
			cwd: targetCwd,
			sessionId: String(sid ?? ""),
			// 恢复的会话 ID 本身就是引擎会话 id → 直接绑定，运行中标记立即可见。
			sessionCacheId: String(sid ?? ""),
			sessionName: "",
			workspaceId: "",
			restored: true,
			pid: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			briefing: "none",
			exited: false,
			exitCode: null,
			status: "idle",
			transcript: "",
			pendingApproval: void 0,
			pty: this.nodePty.spawn(binary, args, {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: targetCwd,
				env: this.agentEnv(targetCwd)
			})
		};
		handle.pid = handle.pty.pid;
		handle.pty.onData((data) => {
			handle.transcript += data;
			if (handle.transcript.length > this.transcriptLimit) handle.transcript = handle.transcript.slice(handle.transcript.length - this.transcriptLimit);
			handle.updatedAt = Date.now();
			handle.lastOutputAt = Date.now();
			const next = deriveStatus(handle.transcript, handle.status);
			if (next !== handle.status) { handle.status = next; this.scheduleStatusNotify(); }
		});
		handle.pty.onExit(({ exitCode }) => {
			clearTimeout(handle._monitorTimer);
			handle.exited = true;
			handle.exitCode = exitCode;
			handle.status = "exited";
			handle.updatedAt = Date.now();
			this.notify();
		});
		this.agents.set(agentId, handle);
		this.notify();
		return handle;
	}
	send(id, text, submit = false) {
		const handle = this.requireLive(id);
		if (submit) {
			// Two-phase write: text first, Enter ~120ms later. A single big
			// write with a trailing \r can be swallowed by a TUI mid-redraw or
			// multi-line input state; splitting makes submission reliable.
			handle.pty.write(text);
			setTimeout(() => {
				try {
					handle.pty.write("\r");
				} catch {}
			}, 120);
		} else {
			handle.pty.write(text);
		}
		handle.updatedAt = Date.now();
	}
	resize(id, cols, rows) {
		const handle = this.requireLive(id);
		handle.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
	}
	signal(id, signal) {
		if (!this.allowedSignals.includes(signal)) throw new Error(`signal "${signal}" not allowed — use ${this.allowedSignals.join(", ")}`);
		const handle = this.agents.get(id);
		if (handle === void 0) throw new Error(`agent "${id}" not found`);
		try {
			handle.pty.kill(signal);
		} catch {}
	}
	/** Click-confirm a prompt. Picks the right key per prompt type/engine:
	 * y/n gates send "y"/"n" (never the bare "1", which confuses codex and can
	 * make it exit); numbered menus keep the numeric choice. */
	approve(id, choice = "1") {
		const handle = this.requireLive(id);
		const key = this._approvalKey(handle, choice);
		this._monLog(handle, `approve choice=${JSON.stringify(choice)} key=${JSON.stringify(key)} engine=${handle.type}`);
		handle.pty.write(key);
		setTimeout(() => {
			try {
				handle.pty.write("\r");
			} catch {}
		}, 120);
		// 若挂起了「待确认」的关键 yes/no，用户已决定 → 清掉并通知刷新。
		if (handle.pendingApproval !== void 0) {
			handle.pendingApproval = void 0;
			this.notify();
		}
		handle.updatedAt = Date.now();
	}
	/** Resolve the key to press for an approval, per prompt type. Prefers the
	 * held pendingApproval (known y/n gate); otherwise inspects the transcript
	 * tail for a y/n vs numbered-menu signature. */
	_approvalKey(handle, choice) {
		const c = String(choice).trim().toLowerCase();
		const isYes = ["1", "y", "yes", "true", "on"].includes(c);
		const isNo = ["2", "n", "no", "false", "off"].includes(c);
		const pa = handle.pendingApproval;
		if (pa !== void 0 && pa.answerType === "yes_no") return isYes ? "y" : isNo ? "n" : (c.slice(0, 1) || "y");
		// 无挂起记录：从转录尾判断是 y/n 还是编号菜单。
		const tail = stripAnsi(String(handle.transcript ?? "").slice(-900));
		const compact = tail.replace(/\s+/g, "");
		const looksYesNo = /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No|continue\?|areyousure/i.test(compact);
		if (looksYesNo) return isYes ? "y" : isNo ? "n" : (c.slice(0, 1) || "y");
		return c; // 编号菜单或未知 → 保留用户/默认的数字。
	}
	/** Start a NEW conversation inside the agent (per-engine command, two-phase submit). */
	newSession(id) {
		const handle = this.requireLive(id);
		const cmd = NEW_SESSION_COMMANDS[handle.type] ?? "/clear";
		handle.pty.write(cmd);
		setTimeout(() => {
			try {
				handle.pty.write("\r");
			} catch {}
		}, 150);
		handle.updatedAt = Date.now();
	}
	/** Compact the current session context (per-engine command, two-phase submit). Reduces token usage by summarizing without clearing history. */
	compactSession(id) {
		const handle = this.requireLive(id);
		const cmd = COMPACT_SESSION_COMMANDS[handle.type];
		if (!cmd) throw new Error(`agent type "${handle.type}" does not support session compaction`);
		handle.pty.write(cmd);
		setTimeout(() => {
			try {
				handle.pty.write("\r");
			} catch {}
		}, 150);
		handle.updatedAt = Date.now();
	}
	// ---------------------------------------------------------------------------
	// Cache introspection / compression (per engine)
	// ---------------------------------------------------------------------------
	/** Resolve the cache locations for an agent type + cwd, with sizes in bytes. */
	cacheInfo(type, cwd) {
		const dirs = [];
		const home = homedir();
		if (type === "claude") {
			// claude's project dir hashes the cwd with every non-alphanumeric char → "-"
			const project = `-${String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-").replace(/^-/, "")}`;
			dirs.push(join(home, ".claude", "projects", project));
		} else if (type === "opencode") {
			dirs.push(join(home, ".local", "share", "opencode"));
			dirs.push(join(home, ".cache", "opencode"));
		} else if (type === "codex") {
			dirs.push(join(home, ".codex", "sessions"));
		} else if (type === "codebuddy") {
			dirs.push(join(home, ".codebuddy", "projects"));
		} else if (type === "pi") {
			dirs.push(join(home, ".pi", "sessions"));
		} else if (type === "qwen") {
			dirs.push(join(home, ".qwen"));
		}
		let total = 0;
		const items = [];
		for (const dir of dirs) {
			const size = dirSize(dir);
			if (size > 0 || existsSync(dir)) {
				total += size;
				items.push({ path: dir, size });
			}
		}
		return { type, dirs: items, total };
	}
	/** One-click compress: VACUUM sqlite DBs and gzip session logs older than 1 day. Returns freed bytes. */
	async compressCache(type, cwd) {
		const info = this.cacheInfo(type, cwd);
		let freed = 0;
		const compressed = [];
		const sqlite = loadSqlite();
		for (const dir of info.dirs) {
			if (!existsSync(dir)) continue;
			// 1) VACUUM sqlite databases
			for (const dbPath of walkFiles(dir, (p) => p.endsWith(".db") || p.endsWith(".sqlite") || p.endsWith(".sqlite3"))) {
				try {
					const before = statSize(dbPath);
					const db = new sqlite.DatabaseSync(dbPath);
					db.exec("VACUUM;");
					db.close();
					const after = statSize(dbPath);
					freed += Math.max(0, before - after);
					compressed.push({ path: dbPath, before, after });
				} catch (err) {
					console.warn("[dsh-agent-commander] VACUUM failed for", dbPath, err?.message ?? err);
				}
			}
			// 2) gzip session logs (jsonl/json) older than 1 day
			const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
			for (const file of walkFiles(dir, (p) => (p.endsWith(".jsonl") || p.endsWith(".json")) && !p.endsWith(".gz"))) {
				try {
					const st = statOf(file);
					if (st === null || st.mtimeMs > dayAgo) continue;
					const before = st.size;
					await gzipFile(file);
					freed += before;
					compressed.push({ path: file, before, after: 0, gzipped: true });
				} catch {}
			}
		}
		return { type, freed, total: info.total, items: compressed };
	}
	/** Aggregate cache info across all open agents. */
	allCacheInfo() {
		return [...this.agents.values()].map((handle) => this.cacheInfo(handle.type, handle.cwd));
	}
	read(id, maxBytes = 12000) {
		const handle = this.requireLive(id);
		let text = handle.transcript;
		let truncated = false;
		if (text.length > maxBytes) {
			text = text.slice(text.length - maxBytes);
			truncated = true;
		}
		return { output: stripAnsi(text), truncated, exited: handle.exited, exitCode: handle.exitCode, status: handle.status };
	}
	/**
	* Close an agent. `graceful` asks the agent to exit itself first (claude:
	* `/exit`, others: `exit`) and only escalates (SIGINT → kill) if the process
	* does not leave within the grace windows — the UI's ✕ uses this so agents
	* shut down cleanly instead of being SIGKILLed mid-work. A unified cleanup
	* clears both timers and the exit subscription on EVERY exit path.
	*/
	close(id, graceful = false) {
		const handle = this.agents.get(id);
		if (handle === void 0) throw new Error(`agent "${id}" not found`);
		// Exit monitor: stop auto-answering, mark the agent 退出中 and keep the
		// handle until the PTY process has FULLY exited (cleanup below runs on
		// the real onExit, or after the kill escalation for stuck processes).
		if (handle._monitor !== void 0) handle._monitor.phase = "exit";
		if (!handle.exited) {
			handle.status = "closing";
			this.notify();
		}
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) return;
			cleaned = true;
			clearTimeout(handle.__closeGraceTimer);
			clearTimeout(handle.__closeKillTimer);
			handle.__exitSub?.dispose?.();
			if (this.agents.get(id) === handle) {
				this.agents.delete(id);
				this.notify();
				this.persist();
			}
		};
		if (!graceful || handle.exited) {
			handle.__exitSub = handle.pty.onExit(() => cleanup());
			try {
				handle.pty.kill();
			} catch {}
			// give the process a moment to exit before dropping the handle
			setTimeout(() => cleanup(), 300);
			return;
		}
		handle.__exitSub = handle.pty.onExit(() => cleanup());
		const exitCmd = EXIT_COMMANDS[handle.type] ?? "";
		if (exitCmd !== "") {
			try {
				handle.pty.write(`${exitCmd}\r`);
			} catch {}
		}
		// Engines with no text exit (opencode) fall through to SIGINT escalation.
		handle.__closeGraceTimer = setTimeout(() => {
			if (this.agents.get(id) !== handle || handle.exited) return;
			try {
				handle.pty.kill("SIGINT");
			} catch {}
			handle.__closeKillTimer = setTimeout(() => {
				if (this.agents.get(id) !== handle || handle.exited) return;
				try {
					handle.pty.kill();
				} catch {}
				cleanup();
			}, 4000);
		}, 5000);
		this.notify();
	}
	requireLive(id) {
		const handle = this.agents.get(id);
		if (handle === void 0) throw new Error(`agent "${id}" not found`);
		if (handle.exited) throw new Error(`agent "${id}" has exited (code ${handle.exitCode ?? "?"})`);
		return handle;
	}
	disposeAll() {
		if (this.statusSweepTimer !== null) { clearInterval(this.statusSweepTimer); this.statusSweepTimer = null; }
		if (this.statusTimer !== null) { clearTimeout(this.statusTimer); this.statusTimer = null; }
		for (const id of [...this.agents.keys()]) this.close(id);
	}
	/**
	* Persist workspace config: each project root's `.deepseek/agents.json`
	* records its open agents (count, session ids, cwd, pid), and a global index
	* (~/.dsh/agent-commander/workspaces.json) remembers every known project so
	* a restart can restore even before a session opens.
	*
	* Rules:
	*   • ONLY live (non-exited) agents are written — closing/exiting an agent
	*     deletes its record, so it never comes back as a "restore" after reboot.
	*   • No transcript dumps (transcriptTail removed — raw terminal bytes are
	*     garbage in JSON and useless for restore).
	*   • All configs land in the PROJECT ROOT (the session working directory of
	*     the agent that created them), not scattered per subfolder cwd.
	*   • Workspaces whose agents are all gone get their agents.json deleted.
	*/
	persist() {
		try {
			const state = [...this.agents.values()]
				.filter((handle) => !handle.exited)
				.map((handle) => this.meta(handle));
			// Group by project root (defaults to the session's working directory).
			const byCwd = new Map();
			for (const entry of state) {
				const cwd = this.projectRootOf !== null ? this.projectRootOf(entry) : (entry.cwd || this.baseCwd);
				if (!byCwd.has(cwd)) byCwd.set(cwd, []);
				byCwd.get(cwd).push(entry);
			}
			const indexFile = join(dshDataDir(), "workspaces.json");
			let prev = [];
			try {
				prev = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : [];
			} catch {}
			const prevRoots = Array.isArray(prev) ? [...new Set(prev)] : [];
			// While restoring (restoreState/scanCwd re-spawning saved agents)
			// the file writes are skipped entirely: the config files already
			// hold the saved data, and rewriting them mid-loop would drop the
			// not-yet-processed entries of the same root. The restore paths
			// own the files and reconcile them when they finish.
			if (!this.restoring) {
				for (const [cwd, entries] of byCwd) {
					mkdirSync(join(cwd, this.memoryDir), { recursive: true });
					writeFileSync(join(cwd, this.memoryDir, "agents.json"), JSON.stringify({ agents: entries }, null, 2), "utf8");
				}
			}
			// Cleanup: roots with no live agents in THIS registry no longer need
			// a config. The registry is the source of truth — the file's own
			// `exited` flags go stale the moment a closed agent stops being
			// persisted (persist with an empty live set used to rewrite
			// nothing, and the old hasLive check then read that stale file and
			// kept it), which is exactly how closed agents resurrected on
			// restart. Only explicitly-exited / no-longer-installable records
			// are kept as "ghosts" (已保存·未运行 cards); the file is deleted
			// when nothing worth keeping remains.
			for (const cwd of prevRoots) {
				if (byCwd.has(cwd)) continue;
				if (this.restoring || this.shuttingDown) continue;
				try {
					const file = join(cwd, this.memoryDir, "agents.json");
					if (!existsSync(file)) continue;
					let saved = [];
					try {
						const parsed = JSON.parse(readFileSync(file, "utf8"));
						const list = Array.isArray(parsed) ? parsed : parsed?.agents;
						if (Array.isArray(list)) saved = list;
					} catch {}
					const ghosts = saved.filter((e) => e != null && typeof e === "object"
						&& (e.exited === true || !AGENT_TYPES.includes(e?.type) || resolveBinary(e?.type) === null));
					if (ghosts.length === 0) unlinkSync(file);
					else writeFileSync(file, JSON.stringify({ agents: ghosts }, null, 2), "utf8");
				} catch {}
			}
			// Rebuild the global workspace index: keep only roots with a config.
			const merged = new Set();
			for (const cwd of [...prevRoots, ...byCwd.keys()]) {
				if (existsSync(join(cwd, this.memoryDir, "agents.json"))) merged.add(cwd);
			}
			mkdirSync(dirname(indexFile), { recursive: true });
			writeFileSync(indexFile, JSON.stringify([...merged], null, 2), "utf8");
		} catch (error) {
			console.warn("[dsh-agent-commander] persist failed:", error?.message ?? error);
		}
	}
	/** Re-spawn one saved agent entry (from a folder's .deepseek/agents.json).
	 * Shared by restoreState / scanCwd / restoreSaved. Returns the live handle,
	 * the existing handle if it is already running, or null when the entry is
	 * exited / malformed / cannot be spawned. */
	spawnSaved(entry, fallbackCwd) {
		if (entry == null || typeof entry !== "object") return null;
		if (!AGENT_TYPES.includes(entry?.type)) return null;
		if (entry.exited === true) return null;
		const existing = this.agents.get(entry?.id);
		if (existing !== void 0) return existing;
		try {
			return this.create({
				type: entry.type,
				name: entry.name,
				role: entry.role,
				skills: entry.skills,
				cwd: entry.cwd ?? fallbackCwd,
				cols: 80,
				rows: 24,
				id: entry.id,
				sessionId: entry.sessionId,
				sessionName: entry.sessionName,
				workspaceId: entry.workspaceId,
				restored: true
			});
		} catch (error) {
			console.warn(`[dsh-agent-commander] spawn saved agent ${entry?.id ?? "?"} failed:`, error?.message ?? error);
			return null;
		}
	}
	/** Re-detect a folder's saved agent config (.deepseek/agents.json): restore
	 * non-exited saved agents that are not running, and return the folder's live
	 * agents plus ghost records for saved agents that could not be spawned. This
	 * is what makes the radar list follow the workspace after every workspace
	 * switch. Closed/exited agents are purged from the file here (self-heal), so
	 * they never resurface as "restore" cards. */
	scanCwd(cwd) {
		const target = typeof cwd === "string" && cwd !== "" ? resolve(cwd) : this.baseCwd;
		const file = join(target, this.memoryDir, "agents.json");
		let saved = [];
		if (existsSync(file)) {
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8"));
				const list = Array.isArray(parsed) ? parsed : parsed?.agents;
				if (Array.isArray(list)) saved = list;
			} catch {}
		}
		// Drop stale closed records left by the OLD persist (exited yet still
		// spawnable — 关闭即删除 leftovers) and keep live records plus genuine
		// ghosts (explicitly exited, or an engine that is no longer installed).
		// Note: records with a stale `exited:false` flag can't be told apart
		// from legitimately-saved agents here — persist() keeps the config
		// accurate so such records never exist in the first place.
		const kept = saved.filter((e) => e != null && typeof e === "object"
			&& (e.exited !== true || !AGENT_TYPES.includes(e?.type) || resolveBinary(e?.type) === null));
		let restored = 0;
		const ghosts = [];
		// Guard persist() (triggered by create() while spawning) against
		// rewriting this folder's config mid-loop, which would drop the
		// not-yet-processed saved entries. The config is reconciled below
		// once the whole list has been processed.
		this.restoring = true;
		try {
			for (const entry of kept) {
				if (entry == null || typeof entry !== "object") continue;
				if (!AGENT_TYPES.includes(entry?.type)) continue;
				// Already running in this registry? Keep it, but don't count as
				// "restored" — only newly spawned agents count. spawnSaved returns
				// null when the entry cannot be spawned (never undefined).
				const alreadyRunning = entry.id !== void 0 && this.agents.has(entry.id);
				const handle = alreadyRunning ? this.agents.get(entry.id) : this.spawnSaved(entry, target);
				if (handle !== null) {
					if (!alreadyRunning) restored += 1;
					continue;
				}
				// Saved but could not be spawned (engine no longer installed, …):
				// keep it visible as "已保存·未运行" so the user can retry or forget it.
				ghosts.push({ ...entry, running: false, status: "exited" });
			}
		} finally {
			this.restoring = false;
		}
		// Reconcile the config: write back the kept records (live agents +
		// ghosts), delete the file when nothing remains.
		if (kept.length === 0) {
			try { unlinkSync(file); } catch {}
		} else {
			try {
				writeFileSync(file, JSON.stringify({ agents: kept }, null, 2), "utf8");
			} catch {}
		}
		return { agents: this.listByCwd(target), saved: ghosts, restored };
	}
	/** Forget (delete) ONE saved agent record of a folder — the ghost ✕ button.
	 * Removes the entry from the project root's agents.json (deletes the file
	 * when it becomes empty). */
	forgetSaved(cwd, id) {
		const target = typeof cwd === "string" && cwd !== "" ? resolve(cwd) : this.baseCwd;
		const file = join(target, this.memoryDir, "agents.json");
		if (!existsSync(file)) return { removed: false };
		let saved = [];
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			const list = Array.isArray(parsed) ? parsed : parsed?.agents;
			if (Array.isArray(list)) saved = list;
		} catch {
			return { removed: false };
		}
		const next = saved.filter((e) => e == null || typeof e !== "object" || e.id !== id);
		if (next.length === saved.length) return { removed: false };
		try {
			if (next.length === 0) unlinkSync(file);
			else writeFileSync(file, JSON.stringify({ agents: next }, null, 2), "utf8");
		} catch {
			return { removed: false };
		}
		return { removed: true };
	}
	/** Re-spawn ONE saved agent of a folder (the ghost "恢复" button). */
	restoreSaved(cwd, id) {
		const target = typeof cwd === "string" && cwd !== "" ? resolve(cwd) : this.baseCwd;
		const existing = this.agents.get(id);
		if (existing !== void 0) return this.meta(existing);
		const file = join(target, this.memoryDir, "agents.json");
		if (!existsSync(file)) throw new Error(`no saved agents config in "${target}"`);
		let saved = [];
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			const list = Array.isArray(parsed) ? parsed : parsed?.agents;
			if (Array.isArray(list)) saved = list;
		} catch {
			throw new Error(`cannot read "${file}"`);
		}
		const entry = saved.find((e) => e != null && typeof e === "object" && e.id === id);
		if (entry === void 0) throw new Error(`agent "${id}" not found in "${file}"`);
		const handle = this.spawnSaved(entry, target);
		if (handle === null) throw new Error(`agent "${id}" cannot be restored (type "${entry?.type ?? "?"}" not installed or exited)`);
		return this.meta(handle);
	}
	/** Re-spawn every saved non-exited agent from ALL known workspaces, replaying transcript tails as context. */
	restoreState() {
		if (this.nodePty === null) return 0;
		this.restoring = true;
		let restored = 0;
		try {
			const indexFile = join(dshDataDir(), "workspaces.json");
			const roots = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : [];
			if (!Array.isArray(roots)) return 0;
			const seen = new Set();
			for (const root of roots) {
				const file = join(root, this.memoryDir, "agents.json");
				if (!existsSync(file)) continue;
				let state;
				try {
					state = JSON.parse(readFileSync(file, "utf8"));
				} catch {
					continue;
				}
				const list = Array.isArray(state) ? state : state?.agents;
				if (!Array.isArray(list)) continue;
				for (const entry of list) {
					if (entry == null || typeof entry !== "object") continue;
					if (seen.has(entry?.id)) continue;
					seen.add(entry?.id);
					if (this.spawnSaved(entry, root) !== null) restored += 1;
				}
			}
		} catch (error) {
			console.warn("[dsh-agent-commander] restoreState failed:", error?.message ?? error);
		} finally {
			this.restoring = false;
		}
		if (restored > 0) console.info(`[dsh-agent-commander] restored ${restored} agent(s) from workspace configs`);
		return restored;
	}
	/** App shutdown: save live state for the next boot, then kill every PTY. */
	shutdown() {
		if (this.statusSweepTimer !== null) { clearInterval(this.statusSweepTimer); this.statusSweepTimer = null; }
		if (this.statusTimer !== null) { clearTimeout(this.statusTimer); this.statusTimer = null; }
		// shuttingDown guards persist() against the exit events that killing
		// the PTYs triggers: the first persist below already captured the live
		// config, and the post-kill onExit persists must not delete it.
		this.shuttingDown = true;
		this.persist();
		for (const handle of this.agents.values()) {
			try {
				handle.pty.kill();
			} catch {}
		}
	}
	subscribe(fn) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	notify() {
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch {}
		}
	}
};

function stripAnsi(text) {
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b[()][AB0]/g, "");
}

// ---------------------------------------------------------------------------
// HTTP/WS helpers
// ---------------------------------------------------------------------------
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}
function writeOk(res, value) {
	writeJson(res, 200, { ok: true, value });
}
function writeError(res, error) {
	const status = typeof error?.status === "number" ? error.status : 500;
	writeJson(res, status, {
		ok: false,
		error: {
			code: "agent-commander-error",
			message: error instanceof Error ? error.message : String(error)
		}
	});
}
function readBody(req, limit = BODY_LIMIT) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				req.destroy();
				reject(new Error("request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (req.destroyed) return;
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (raw === "") {
				resolvePromise({});
				return;
			}
			try {
				resolvePromise(JSON.parse(raw));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}
function sessionCwdOf(ctx, sessionId, fallback) {
	const headerCwd = sessionId === void 0 ? void 0 : ctx.sessions.get(sessionId)?.header?.cwd;
	if (headerCwd !== void 0 && headerCwd !== "") return headerCwd;
	if (fallback !== void 0 && fallback !== "") return validateCwd(fallback, undefined);
	return process.cwd();
}

// ---------------------------------------------------------------------------
// Model-facing tools
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const sessionId = exec.agent?.session?.id;
			const cwd = sessionCwdOf(ctx, sessionId, args.cwd);
			const handle = registry.create({
				type: args.type,
				name: args.name,
				role: args.role,
				skills: args.skills,
				cwd,
				cols: 80,
				rows: 24
			});
			return Promise.resolve({ id: handle.id, name: handle.name, type: handle.type, role: handle.role });
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
		description: "Read the recent output of an agent terminal (last N bytes of its transcript, ANSI stripped). Use this to see what the agent is doing and collect its report after dispatching a task. Pair with agent_send: send a task, wait, read output until the agent reports completion (look for its summary / task-board update).",
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			registry.send(args.id, args.text, args.submit === true);
			return Promise.resolve({ id: args.id, submitted: args.submit === true });
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			const ids = Array.isArray(args.ids) ? args.ids.filter((s) => typeof s === "string" && s !== "") : [];
			const submit = args.submit !== false;
			const results = [];
			for (const id of ids) {
				try {
					registry.send(id, String(args.text ?? ""), submit);
					const handle = registry.get(id);
					results.push({ id, name: handle?.name ?? id, sent: true, error: null });
				} catch (error) {
					results.push({ id, name: id, sent: false, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return Promise.resolve(results);
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			registry.signal(args.id, args.signal);
			return Promise.resolve({ id: args.id, signal: args.signal });
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			registry.close(args.id);
			return Promise.resolve({ id: args.id, closed: true });
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			registry.approve(args.id, args.choice);
			return Promise.resolve({ id: args.id, choice: args.choice ?? "1" });
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
		execute: (args, exec) => {
			exec.signal.throwIfAborted();
			registry.compactSession(args.id);
			return Promise.resolve({ id: args.id, compacted: true });
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
					agentTypes: AGENT_TYPES,
					apiPrefix: API_PREFIX,
					wsTerminal: WS_TERMINAL,
					wsList: WS_LIST,
					wsSessions: WS_SESSIONS,
					monitorIntervalMs: Number.isFinite(cfg.monitorIntervalMs) && cfg.monitorIntervalMs > 0 ? Math.trunc(cfg.monitorIntervalMs) : MONITOR_INTERVAL_MS
				} });
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
			// 会话历史（cc-switch 式）：列出 / 恢复 / 删除。列表复用巡检的 buildSessionList，
			// 保证 API 与 WS 推送的列表一致。
			if (req.method === "GET" && path === "/sessions") {
				const cwd = url.searchParams.get("cwd") ?? "";
				writeOk(res, { sessions: await buildSessionList(registry, scanner, cwd) });
				return;
			}
			if (req.method === "POST" && path === "/sessions/restore") {
				const body = await rb(req);
				const cwd = sessionCwdOf(ctx, body.sessionId, body.cwd);
				const handle = await registry.restoreSession({ engine: String(body.engine ?? ""), sessionId: String(body.id ?? ""), cwd, name: body.name });
				writeOk(res, { agent: registry.meta(handle) });
				return;
			}
			const sessionDelete = path.match(/^\/sessions\/([^/]+)\/([^/]+)$/);
			if (sessionDelete !== null && req.method === "DELETE") {
				const [, engine, id] = sessionDelete;
				const cwd = sessionCwdOf(ctx, url.searchParams.get("sessionId"), url.searchParams.get("cwd"));
				const resDel = scanner !== null && typeof scanner.deleteSession === "function"
					? await scanner.deleteSession(engine, decodeURIComponent(id), cwd)
					: false;
				writeOk(res, { engine, id: decodeURIComponent(id), deleted: resDel !== false });
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
				const handle = registry.create({
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
				registry.close(id, graceful);
				writeOk(res, { id, closed: true, graceful });
				return;
			}
			// Standard agent methods: send / read / approve / signal / status / new-session
			const agentMatch = path.match(/^\/agents\/([^/]+)\/(send|read|approve|signal|status|new-session|compact)$/);
			if (agentMatch !== null) {
				const [, id, op] = agentMatch;
				if (op === "send" && req.method === "POST") {
					const body = await rb(req);
					registry.send(id, String(body.text ?? ""), body.submit === true);
					writeOk(res, { id, submitted: body.submit === true });
					return;
				}
				if (op === "read" && req.method === "GET") {
					const bytes = Number(url.searchParams.get("bytes") ?? 12000);
					writeOk(res, registry.read(id, Number.isFinite(bytes) ? bytes : 12000));
					return;
				}
				if (op === "approve" && req.method === "POST") {
					const body = await rb(req);
					registry.approve(id, body.choice === void 0 ? "1" : String(body.choice));
					writeOk(res, { id, choice: body.choice === void 0 ? "1" : String(body.choice) });
					return;
				}
				if (op === "signal" && req.method === "POST") {
					const body = await rb(req);
					registry.signal(id, String(body.signal ?? ""));
					writeOk(res, { id, signal: body.signal });
					return;
				}
				if (op === "new-session" && req.method === "POST") {
					registry.newSession(id);
					writeOk(res, { id, newSession: true });
					return;
				}
				if (op === "compact" && req.method === "POST") {
					registry.compactSession(id);
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
function registerWebsockets(ctx, registry, fence, cfg = {}, monitor = null) {
	const { WebSocketServer } = getWs();
	const terminalWss = new WebSocketServer({ noServer: true });
	const listWss = new WebSocketServer({ noServer: true });
	const sessionsWss = new WebSocketServer({ noServer: true });
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: WS_TERMINAL,
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			terminalWss.handleUpgrade(req, socket, head, (ws) => attachTerminal(registry, ws, req, cfg));
		}
	}), "dsh-agent-commander: terminal WebSocket");
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
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: WS_SESSIONS,
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			sessionsWss.handleUpgrade(req, socket, head, (ws) => attachSessions(ws, req, monitor));
		}
	}), "dsh-agent-commander: sessions WebSocket");
	ctx.effect(() => () => {
		terminalWss.close();
		listWss.close();
		sessionsWss.close();
	}, "dsh-agent-commander: websocket teardown");
}

function attachSessions(ws, req, monitor) {
	// ?cwd= 指定订阅的工作目录；subscribe 时先推一帧，之后随巡检推送变化。
	let cwd = "";
	try {
		cwd = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("cwd") ?? "";
	} catch {}
	const { WebSocket } = getWs();
	const send = (payload) => {
		if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
			try {
				ws.send(JSON.stringify({ type: "sessions", ...payload }));
			} catch {}
		}
	};
	let unsub = () => {};
	if (monitor !== null && typeof monitor.watch === "function") {
		unsub = monitor.watch(cwd, (payload) => send(payload));
	}
	ws.on("close", () => unsub());
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

function attachTerminal(registry, ws, req, cfg = {}) {
	try {
		const url = new URL(req.url ?? "/", "http://dsh.internal");
		const id = url.searchParams.get("id");
		const handle = registry.get(id ?? "");
		if (handle === void 0) {
			ws.close(1011, "agent not found");
			return;
		}
		const wsInputLimit = Number.isFinite(cfg.wsInputLimit) && cfg.wsInputLimit > 0 ? cfg.wsInputLimit : WS_INPUT_LIMIT;
		if (handle.transcript !== "") ws.send(handle.transcript);
		const { WebSocket } = getWs();
		const onData = (data) => {
			if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(data);
		};
		const onExit = ({ exitCode }) => {
			onData(`\r\n[dsh-agent-commander] 智能体进程已退出（code ${String(exitCode)}）\r\n`);
		};
		const dataSub = handle.pty.onData(onData);
		const exitSub = handle.pty.onExit(onExit);
		ws.on("message", (data) => {
			const text = data.toString("utf8");
			let control = null;
			try {
				const parsed = JSON.parse(text);
				if (parsed !== null && typeof parsed === "object") control = parsed;
			} catch {}
			// Input must be a structured frame {type:"input", data}; bare strings
			// are dropped (defense in depth — the fence guards the handshake,
			// this guards the payload). Single-frame size is capped.
			if (control === null || typeof control.type !== "string") return;
			if (control.type === "input" && typeof control.data === "string") {
				if (handle.exited) return;
				if (control.data.length > wsInputLimit) return;
				try {
					handle.pty.write(control.data);
				} catch {}
				return;
			}
			if (control.type === "resize" && typeof control.cols === "number" && typeof control.rows === "number") {
				try {
					handle.pty.resize(Math.max(2, Math.floor(control.cols)), Math.max(2, Math.floor(control.rows)));
				} catch {}
				return;
			}
			if (control.type === "signal" && typeof control.signal === "string") {
				if (!registry.allowedSignals.includes(control.signal)) return;
				try {
					handle.pty.kill(control.signal);
				} catch {}
				return;
			}
			if (control.type === "close") {
				registry.close(handle.id, control.graceful === true);
				return;
			}
		});
		ws.on("close", () => {
			dataSub.dispose();
			exitSub.dispose();
		});
		ws.on("error", () => {
			dataSub.dispose();
			exitSub.dispose();
		});
	} catch (error) {
		ws.close(1011, error instanceof Error ? error.message : String(error));
	}
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
		this.nodePty = loadNodePty();
		ensureSpawnHelper();
		// The agent-commander skill rides inside this bundle; make it available
		// to ~/.agents/skills so the model picks it up (best-effort, no-clobber).
		ensureBundledSkillInstalled();
		if (this.nodePty === null) {
			ctx.logger?.warn?.("[dsh-agent-commander] node-pty unavailable — agent spawn disabled");
		}
		// Mount into the framework (official plugin mechanism): contribute a
		// global system-prompt section so EVERY conversation — new windows and
		// fresh sessions included — knows the team-agent capability exists and
		// how to discover/operate the agents. Without this the model only sees
		// bare tool schemas and never learns the workflow (reported: 新对话里
		// 不知道怎么找到智能体、怎么操作智能体). The registration is auto-disposed
		// when the plugin unloads, per the Cordis lifecycle.
		if (this.nodePty !== null) {
			try {
				ctx.systemPrompt.section({
					name: "dsh-agent-commander:team",
					order: 150,
					text: [
						"团队智能体（Agent Radar）：",
						"右侧「智能体雷达」面板管理真实终端智能体（claude / opencode / codex 等），你可以直接指挥它们：",
						"1. 先用 agent_list 查看已打开的智能体（含 id、引擎、状态、工作目录）；当前工作区没有时会自动列出其他工作区的智能体，跨窗口/跨会话同样可见可操作。",
						"2. agent_open 新建（type/name/role/skills/cwd）；角色与技能会作为开场简报在启动完成后自动注入并回车执行。",
						"3. agent_send 派发任务（submit=true 会按回车执行）；agent_broadcast 把同一任务并行派给多个智能体做协同；agent_read 轮询输出直到完成。",
						"4. agent_approve 确认权限提问；agent_signal 发中断；agent_close 关闭（先优雅 /exit，再升级 SIGINT/SIGKILL）。",
						"5. 团队共享记忆：项目 .deepseek/ 下 memory.md、task-board.md、experience.md、handoffs/ 与 SQLite 记忆库 memory.db；智能体开工先读、完成后回写。"
					].join("\n")
				});
			} catch {}
		}
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
			memoryDir: typeof config.memoryDir === "string" && config.memoryDir !== "" ? config.memoryDir : MEMORY_DIR
		};
		this.baseCwd = this.cfg.baseCwd;
		this.memoryDir = this.cfg.memoryDir;
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
		this.sessionScanner = new SessionScanner();
		this.registry = new AgentRegistry(this.nodePty, this.cfg.maxAgents, this.baseCwd, (cwd) => this.storeFor(cwd), (handle) => this.projectRootOf(handle), {
			transcriptLimit: this.cfg.transcriptLimit,
			allowedSignals: this.cfg.allowedSignals,
			memoryDir: this.memoryDir
		});
		const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts);
		const resolveCwd = (sessionId) => sessionCwdOf(ctx, sessionId);
		const monitorInterval = Number.isFinite(this.cfg.monitorIntervalMs) && this.cfg.monitorIntervalMs > 0
			? Math.trunc(this.cfg.monitorIntervalMs)
			: MONITOR_INTERVAL_MS;
		this.sessionMonitor = new SessionMonitor({
			registry: this.registry,
			scanner: this.sessionScanner,
			intervalMs: monitorInterval,
			logger: ctx.logger
		});
		registerApi(ctx, this.registry, (cwd) => this.storeFor(cwd), fence, resolveCwd, this.cfg, this.sessionScanner);
		registerWebsockets(ctx, this.registry, fence, this.cfg, this.sessionMonitor);
		let toolsDisposers = null;
		if (this.nodePty !== null) {
			toolsDisposers = registerTools(ctx, this.registry, (cwd) => this.storeFor(cwd), resolveCwd);
		}
		// Restore agents that were open before the app restarted (state saved in
		// <memoryDir>/agents.json on shutdown).
		if (this.nodePty !== null) {
			this.registry.restoreState();
		}
		ctx.effect(() => () => {
			toolsDisposers?.();
			// shutdown(): save live state for the NEXT boot, then kill PTYs.
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
	open(opts) {
		const handle = this.registry.create(opts);
		return this.registry.meta(handle);
	}
	/** Send text to an agent (submit=true presses Enter). */
	send(id, text, submit) {
		this.registry.send(id, text, submit === true);
		return { id };
	}
	/** Read an agent's recent output (ANSI-stripped). */
	read(id, bytes) {
		return this.registry.read(id, bytes);
	}
	/** Click-confirm a prompt (default choice "1" = Yes). */
	approve(id, choice) {
		this.registry.approve(id, choice);
		return { id };
	}
	/** Send a whitelisted signal (SIGINT/SIGTSTP/SIGTERM). */
	signal(id, signal) {
		this.registry.signal(id, signal);
		return { id };
	}
	/** Close an agent (graceful = ask it to /exit first). */
	close(id, graceful) {
		this.registry.close(id, graceful === true);
		return { id };
	}
	/** Get one agent's live status/meta (null when unknown). */
	status(id) {
		const handle = this.registry.get(id);
		return handle === void 0 ? null : this.registry.meta(handle);
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
			memoryDir: this.memoryDir
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
