// ============================================================================
// herdr-registry.js — Agent Radar registry facade backed by herdr.
//
// Implements the SAME surface the tools / HTTP API / WebSocket layer consume
// from the legacy node-pty AgentRegistry, so the plugin can swap hosts without
// touching the model-facing agent_* contract:
//
//   sync  : list / listByCwd / get / meta / subscribe / scanCwd / restoreSaved
//           / forgetSaved / newSession / allCacheInfo / compressCache /
//           restoreState / agents / maxAgents / allowedSignals / ...
//   async : create / read / send / approve / signal / close / compactSession
//
// Mapping (see docs/herdr-integration-dev.md §4):
//   DSH id (8-hex)  →  herdr agent name "a<id>"  ([a-z][a-z0-9_-]{0,31})
//   cwd             →  herdr workspace (auto-created when missing)
//   status          →  herdr idle/done/working/blocked/unknown (done→idle)
// ============================================================================

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { HerdrAdapter, HerdrError, HERDR_ERRORS } from "./herdr-adapter.js";
import { resolveEngineBinary } from "./terminal-registry.js";

/** DSH engine type → herdr `agent start --kind`. codebuddy 无 herdr kind。 */
export const HERDR_KIND_MAP = {
	claude: "claude",
	opencode: "opencode",
	codex: "codex",
	qwen: "qwen",
	pi: "pi"
};

/**
 * 没有 herdr kind 的引擎 → 走「裸 pane」模式：herdr 建一个 pane（排版与普通
 * agent 一致），插件直接在 pane 里输入引擎启动命令（绝对路径），之后用
 * paneRead 监控输出、paneSendText/Keys 派活与应答。herdr 0.8.2 的 kind 列表
 * 是二进制硬编码的（实测 `agent start --kind codebuddy` 返回 unsupported
 * interactive agent kind，且 manifest 只定义检测规则、不能注册新 kind），
 * 所以「pane 里直接输入命令」是 codebuddy 接入 herdr 的唯一方式。
 */
export const RAW_PANE_ENGINES = new Set(["codebuddy"]);

const POLL_MS = 2000;
// 退出判定宽限：agent 需先被 herdr 列表见过，且消失超过该时长才标 exited
// （覆盖 agentStart 启动期 30-60s 内尚未进入列表的窗口）。
const EXIT_GRACE_MS = 30000;
// 外部（非本插件创建）智能体退出后，缓存保留多久再清理，防幽灵记录累积。
const EXTERNAL_PRUNE_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const execFileAsync = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
	execFile(cmd, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, ...opts }, (error, stdout) => {
		if (error) {
			reject(error);
			return;
		}
		resolve(String(stdout ?? "").trim());
	});
});

// 统计缓存有效期：雷达 2s 轮询时，token/任务统计最多每 30s 重算一次。
const STATS_CACHE_MS = 30000;
// claude 成本估算（$/1M tokens，claude-sonnet-4 量级，仅供参考）。
const CLAUDE_COST_PER_1M = 3;
const OPENCODE_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// 启动/运行期确认弹窗自动应答（与 legacy monitor 同一套识别规则）：
//   • 菜单类（claude 文件夹信任等，默认项即安全项）→ 直接回车
//   • 通用 y/n → 发 y + 回车
// 匹配在去空白后的可见输出上做。
const AUTO_ANSWER_PATTERNS = [
	{ re: /Entertoconfirm·Esctocancel|1\.Yes,Itrustthisfolder|Quicksafetycheck|Doyoutrustthefilesinthisfolder/i, y: false },
	{ re: /Doyouwanttoproceed|Proceed\?|\(y\/n\)|\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(Y\/n\)|yes\/no|Yes\/No/i, y: true },
	{ re: /PressEnterto|Entertoselect|Selectanoption/i, y: false }
];

function slugHerdrName(id) {
	// herdr agent names must match [a-z][a-z0-9_-]{0,31}.
	return ("a" + String(id ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "")).slice(0, 31) || "a" + randomUUID().slice(0, 8);
}

function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return String(text ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function mapStatus(s) {
	if (s === "done") return "idle"; // done ≈ idle（后台工作完成、已就绪）
	if (s === "idle" || s === "working" || s === "blocked" || s === "unknown") return s;
	return "unknown";
}

export class HerdrAgentRegistry {
	constructor(adapter, opts = {}) {
		this.adapter = adapter;
		this.maxAgents = opts.maxAgents ?? 8;
		this.allowedSignals = Array.isArray(opts.allowedSignals) && opts.allowedSignals.length > 0 ? [...opts.allowedSignals] : ["SIGINT", "SIGTSTP", "SIGTERM"];
		this.transcriptLimit = opts.transcriptLimit ?? (1 << 20);
		this.memoryDir = opts.memoryDir ?? ".deepseek";
		this.baseCwd = opts.baseCwd ?? process.cwd();
		this.onSpawn = typeof opts.onSpawn === "function" ? opts.onSpawn : null;
		this.projectRootOf = typeof opts.projectRootOf === "function" ? opts.projectRootOf : null;
		// SessionScanner 用于给运行中的窗口探测「会话缓存 ID」（会话即窗口的对接依据）。
		this.scanner = opts.scanner ?? null;
		this.herdrMode = true;
		this.adapter.version = opts.herdrVersion ?? null;
		this.adapter.selftest().then((r) => {
			this.adapter.version = r.version ?? this.adapter.version;
		}).catch(() => {});
		this.agents = new Map();          // DSH id → handle
		this.listeners = new Set();
		this._polling = false;
		this._lastSnapshot = "";
		this._workspaceCache = new Map(); // cwd → { workspaceId, rootPaneId }
		this._confDirty = new Set();      // cwd → 需要重写 agent.conf
		this._confTimer = null;
		this._pollTimer = setInterval(() => { this.refresh().catch(() => {}); }, POLL_MS);
		this.refresh().catch(() => {});
	}

	/** /terminal/status 兼容面：herdr 模式没有系统终端 App。 */
	get launcher() {
		return { resolveApp: () => "herdr", label: "herdr（tmux pane）" };
	}
	/** /terminal/status engines.installed 兼容面：有 herdr kind 的引擎即可用；
	 *  codebuddy 无 kind → 走裸 pane 模式，二进制存在即视为可用。 */
	get binaries() {
		const out = {};
		for (const type of Object.keys(HERDR_KIND_MAP)) out[type] = "/usr/bin/herdr";
		const cb = resolveEngineBinary("codebuddy");
		if (cb !== null) out.codebuddy = cb;
		return out;
	}

	/** Find the herdr workspace whose panes live in `cwd` (never creates). */
	async findWorkspace(cwd) {
		const wss = await this.adapter.workspaceList();
		for (const ws of wss?.workspaces ?? []) {
			const panes = await this.adapter.paneList(ws.workspace_id);
			if ((panes?.panes ?? []).some((p) => p.cwd === cwd)) {
				return { workspaceId: ws.workspace_id, label: ws.label, paneCount: (panes?.panes ?? []).length };
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ meta
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
			nativeSession: handle.nativeSession ?? "",
			sessionName: handle.sessionName,
			workspaceId: handle.workspaceId,
			paneId: handle.paneId ?? "",
			herdrName: handle.herdrName ?? "",
			restored: handle.restored === true,
			briefing: handle.briefing ?? "none",
			external: handle.external === true,
			createdAt: handle.createdAt,
			updatedAt: handle.updatedAt,
			stats: handle._stats ?? null
		};
	}

	// ------------------------------------------------------------ sync reads
	list() {
		this.refresh().catch(() => {});
		return [...this.agents.values()].map((h) => this.meta(h));
	}
	listByCwd(cwd) {
		this.refresh().catch(() => {});
		return [...this.agents.values()].filter((h) => h.cwd === cwd).map((h) => this.meta(h));
	}
	get(id) {
		return this.agents.get(id);
	}
	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// -------------------------------------------------------- agent creation
	async create({ type, name, role, skills, cwd, cols, rows, id, sessionId, sessionName, workspaceId: dshWorkspaceId }) {
		if (this.agents.size >= this.maxAgents) throw new Error(`agent limit reached (${this.maxAgents})`);
		const kind = HERDR_KIND_MAP[type];
		const rawPane = kind === void 0 && RAW_PANE_ENGINES.has(type);
		if (kind === void 0 && !rawPane) {
			throw new Error(`agent type "${type}" 不支持 herdr 模式（支持：${Object.keys(HERDR_KIND_MAP).join(" / ")} 及裸 pane：${[...RAW_PANE_ENGINES].join(" / ")}）`);
		}
		if (this.adapter.binary === null) throw new Error("herdr binary not found — 无法使用 herdr 模式");
		const targetCwd = typeof cwd === "string" && cwd !== "" ? cwd : this.baseCwd;
		// Seed the shared-memory contract before the agent boots.
		if (this.onSpawn !== null) {
			try {
				this.onSpawn(targetCwd);
			} catch {}
		}
		const { workspaceId, rootPaneId, created: wsCreated } = await this.ensureWorkspace(targetCwd);
		let paneId = await this.findFreePane(workspaceId, targetCwd);
		if (paneId === null) {
			// 窗口排版：复用已释放的空面板；否则从根面板 split。方向按当前
			// 面板数交替（偶数→右侧分栏，奇数→下方分栏），形成可用网格。
			const panes = await this.adapter.paneList(workspaceId);
			const direction = ((panes?.panes?.length ?? 1) % 2 === 0) ? "down" : "right";
			const split = await this.adapter.paneSplit(rootPaneId, direction, targetCwd);
			paneId = split?.pane?.pane_id ?? null;
			if (paneId === null) throw new Error("无法在 herdr 中创建面板（pane split 失败）");
		}
		const agentId = typeof id === "string" && id !== "" ? id : randomUUID().slice(0, 8);
		const herdrName = slugHerdrName(agentId);
		const trimmedRole = (role ?? "").trim();
		const skillList = Array.isArray(skills) ? skills.filter((s) => typeof s === "string") : [];
		const handle = {
			id: agentId,
			herdrName,
			paneId,
			workspaceId,
			type,
			name: (name ?? type).trim() || type,
			role: trimmedRole,
			skills: skillList,
			cwd: targetCwd,
			// 会话缓存 ID：新建会话启动后由 herdr agent_session / 扫描探测填充；
			// 恢复会话时直接就是被恢复的历史会话 id。
			sessionId: "",
			nativeSession: "",
			_sessionSource: "",
			dshSessionId: typeof sessionId === "string" ? sessionId : "",
			sessionName: typeof sessionName === "string" ? sessionName : "",
			restored: false,
			pid: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			briefing: trimmedRole !== "" || skillList.length > 0 ? "pending" : "none",
			status: "unknown",
			exited: false,
			exitCode: null,
			_wsCreated: wsCreated === true,
			_rawPane: rawPane === true
		};
		this.agents.set(agentId, handle);
		this.notify();
		try {
			if (rawPane) {
				// 裸 pane 模式：pane 里直接输入引擎启动命令（绝对路径，不依赖 PATH）。
				const bin = resolveEngineBinary(type);
				if (bin === null) throw new Error(`引擎 "${type}" 未安装（未在 PATH / ~/.local/bin / ~/.opencode/bin / ~/.nvm/versions/node/*/bin 找到）`);
				handle.status = "starting";
				this.updated(handle);
				await this.adapter.paneSendText(paneId, bin);
				await this.adapter.paneSendKeys(paneId, "Enter");
				handle.status = "working";
			} else {
				const started = await this.adapter.agentStart(herdrName, kind, paneId, { timeoutMs: 60000 });
				handle.status = mapStatus(started?.agent?.agent_status);
				if (typeof started?.agent?.agent_session?.value === "string" && started.agent.agent_session.value !== "") {
					handle.nativeSession = started.agent.agent_session.value;
					handle.sessionId = handle.nativeSession;
					handle._sessionSource = "herdr";
				}
			}
		} catch (error) {
			if (!rawPane && error instanceof HerdrError && error.code === HERDR_ERRORS.AGENT_NOT_READY) {
				// 启动期即 blocked（如 claude 的文件夹信任/权限弹窗）：自动应答，
				// 不再卡在灰色界面等手动确认。
				handle.status = "blocked";
				const resolved = await this.autoAnswer(handle, 4);
				if (resolved) {
					handle.status = mapStatus((await this.adapter.agentGet(herdrName).catch(() => null))?.agent?.agent_status) || "idle";
				}
			} else {
				this.agents.delete(agentId);
				this.notify();
				this.markConfDirty(targetCwd);
				throw error;
			}
		}
		this.updated(handle);
		// 会话缓存 ID 探测（claude 的 herdr 集成不总上报 session id，用扫描兜底）。
		this.detectSessionId(handle).catch(() => {});
		this.markConfDirty(targetCwd);
		// 简报注入：herdr agent 用 agentPrompt；裸 pane（codebuddy）走「监控 →
		// 自动应答 → pane 输入」的后台监控，注入完成置 briefing=done。
		if (handle.briefing === "pending") {
			const briefing = this.briefingText(handle);
			if (rawPane) {
				this.monitorRawPane(handle, briefing);
			} else {
				this.injectBriefing(handle, briefing);
			}
		}
		return handle;
	}

	// ------------------------------------------------------------ operations
	async read(id, bytes) {
		const handle = this.requireHandle(id);
		if (handle._rawPane === true) {
			// 裸 pane：直接读 pane 可见输出（不滚动、不动 agent 界面）。
			const limit = Number.isFinite(bytes) && bytes > 0 ? bytes : 12000;
			const lines = Math.max(10, Math.min(120, Math.ceil(limit / 160)));
			let text = "";
			try {
				text = await this.adapter.paneRead(handle.paneId, lines);
			} catch {}
			text = stripAnsi(text);
			const truncated = text.length > limit;
			const output = truncated ? text.slice(-limit) : text;
			handle.lastOutputAt = Date.now();
			handle.updatedAt = Date.now();
			return { output, truncated, exited: handle.exited, status: handle.status, exitCode: handle.exitCode ?? null };
		}
		const limit = Number.isFinite(bytes) && bytes > 0 ? bytes : 12000;
		// 使用 visible 源（被动读取，不滚动 agent 全屏 TUI）；行数限制在可见
		// 屏幕范围内，避免触发 herdr 的多页滚动收集（会让 agent 界面“刷新”）。
		const lines = Math.max(10, Math.min(120, Math.ceil(limit / 160)));
		let text = "";
		try {
			text = await this.adapter.agentRead(handle.herdrName, lines, "visible");
		} catch (error) {
			if (error instanceof HerdrError && (error.code === HERDR_ERRORS.AGENT_NOT_IDLE || error.code === HERDR_ERRORS.AGENT_NOT_FOUND)) {
				text = await this.adapter.paneRead(handle.paneId, 50);
			} else {
				throw error;
			}
		}
		text = stripAnsi(text);
		const truncated = text.length > limit;
		const output = truncated ? text.slice(-limit) : text;
		handle.lastOutputAt = Date.now();
		handle.updatedAt = Date.now();
		return { output, truncated, exited: handle.exited, status: handle.status, exitCode: handle.exitCode ?? null };
	}

	async send(id, text, submit) {
		const handle = this.requireHandle(id);
		if (handle._rawPane === true) {
			if (handle.exited) throw new Error(`agent ${id} 已退出`);
			await this.adapter.paneSendText(handle.paneId, String(text ?? ""));
			if (submit === true) await this.adapter.paneSendKeys(handle.paneId, "Enter");
			handle.updatedAt = Date.now();
			return;
		}
		if (submit === true) {
			await this.adapter.agentPrompt(handle.herdrName, String(text), { wait: false });
		} else {
			await this.adapter.paneSendText(handle.paneId, String(text));
		}
		handle.updatedAt = Date.now();
	}

	async approve(id, choice) {
		const handle = this.requireHandle(id);
		const c = choice === void 0 || choice === null ? "1" : String(choice);
		if (handle._rawPane === true) {
			if (c === "") {
				await this.adapter.paneSendKeys(handle.paneId, "Enter");
			} else {
				await this.adapter.paneSendText(handle.paneId, c);
				await this.adapter.paneSendKeys(handle.paneId, "Enter");
			}
			handle.updatedAt = Date.now();
			return;
		}
		if (handle.status === "blocked" || handle.status === "unknown") {
			try {
				await this.adapter.agentRead(handle.herdrName, 10);
			} catch {}
		}
		if (c === "") {
			await this.adapter.agentSendKeys(handle.herdrName, "enter");
		} else {
			await this.adapter.paneSendText(handle.paneId, c);
			await this.adapter.paneSendKeys(handle.paneId, "Enter");
		}
		handle.updatedAt = Date.now();
		// 若首启审批挡住了简报注入，确认后补注一次。
		if (handle.briefing === "pending" && !handle.exited) {
			const briefing = this.briefingText(handle);
			this.injectBriefing(handle, briefing);
		}
	}

	async signal(id, signal) {
		const handle = this.requireHandle(id);
		if (!this.allowedSignals.includes(signal)) throw new Error(`signal ${signal} 不在白名单（${this.allowedSignals.join(", ")}）`);
		const key = signal === "SIGTSTP" ? "ctrl+z" : "ctrl+c"; // SIGINT / SIGTERM → ctrl+c
		if (handle._rawPane === true) {
			await this.adapter.paneSendKeys(handle.paneId, key);
			handle.updatedAt = Date.now();
			return;
		}
		await this.adapter.agentSendKeys(handle.herdrName, key);
		handle.updatedAt = Date.now();
	}

	async close(id, graceful) {
		const handle = this.requireHandle(id);
		const { paneId, cwd, _wsCreated } = handle;
		if (handle._rawPane === true) {
			if (graceful !== false && !handle.exited) {
				try {
					await this.adapter.paneSendText(paneId, "/exit");
					await this.adapter.paneSendKeys(paneId, "Enter");
				} catch {}
				await sleep(1500);
			}
			if (!handle.exited) {
				try {
					await this.adapter.paneClose(paneId);
				} catch {}
			}
			handle.exited = true;
			handle.status = "exited";
			handle.exitCode = 0;
			this.agents.delete(id);
			this._workspaceCache.delete(cwd);
			// 若该 workspace 是插件为这个 cwd 新建的、且已无其它智能体引用 → 关闭空空间。
			if (_wsCreated === true && ![...this.agents.values()].some((h) => h.workspaceId === handle.workspaceId)) {
				try {
					await this.adapter.workspaceClose(handle.workspaceId);
				} catch {}
			}
			this.markConfDirty(cwd);
			this.notify();
			return;
		}
		if (graceful !== false && !handle.exited) {
			try {
				await this.adapter.agentPrompt(handle.herdrName, "/exit", { wait: true, timeoutMs: 15000 });
			} catch {}
		}
		if (!handle.exited) {
			try {
				await this.adapter.paneClose(paneId);
			} catch {}
		}
		handle.exited = true;
		handle.status = "exited";
		handle.exitCode = 0;
		this.agents.delete(id);
		this._workspaceCache.delete(cwd);
		// 若该 workspace 是插件为这个 cwd 新建的、且已无其它智能体引用 → 关闭空空间。
		if (_wsCreated === true && ![...this.agents.values()].some((h) => h.workspaceId === handle.workspaceId)) {
			try {
				await this.adapter.workspaceClose(handle.workspaceId);
			} catch {}
		}
		this.markConfDirty(cwd);
		this.notify();
	}

	// -------------------------------------------------- 会话即窗口（合并对接）
	/**
	 * 运行中窗口汇总（供 /sessions 标记 running，key = `${engine}:${cwd}`）。
	 * sessionId = 会话缓存 ID（herdr agent_session / 扫描探测），是历史会话
	 * 与实时窗口合并对接的依据。
	 */
	runningSessionKeys() {
		const out = new Map();
		for (const h of this.agents.values()) {
			if (h.exited) continue;
			const sid = (h.sessionId ?? "") !== "" ? h.sessionId : (h.nativeSession ?? "");
			out.set(`${h.type}:${h.cwd}`, {
				agentId: h.id,
				name: h.name,
				type: h.type,
				cwd: h.cwd,
				pid: h.pid ?? null,
				sessionId: sid,
				status: h.status,
				createdAt: h.createdAt,
				paneId: h.paneId ?? "",
				workspaceId: h.workspaceId ?? "",
				herdrName: h.herdrName ?? ""
			});
		}
		return out;
	}

	/** 引擎 → `agent start -- <args>` 的恢复（resume）命令参数。 */
	static resumeArgs(engine, sessionId) {
		if (engine === "claude") return ["--resume", String(sessionId)];
		if (engine === "codex") return ["resume", String(sessionId)];
		if (engine === "opencode") return ["-s", String(sessionId)];
		return null;
	}

	/**
	 * 恢复一个历史会话：**新开一个 pane**（会话即窗口），在 pane 里用引擎的
	 * resume 命令拉起对应会话缓存。返回新 handle（restored=true）。
	 * 裸 pane 引擎（codebuddy）：pane 里直接输入 `<bin> --resume <id>`。
	 */
	async restoreSession({ engine, sessionId, cwd, name }) {
		const kind = HERDR_KIND_MAP[engine];
		const rawPane = kind === void 0 && RAW_PANE_ENGINES.has(engine);
		if (kind === void 0 && !rawPane) throw new Error(`engine "${engine}" 不支持 herdr 恢复（支持：${Object.keys(HERDR_KIND_MAP).join(" / ")} 及裸 pane：${[...RAW_PANE_ENGINES].join(" / ")}）`);
		if (typeof sessionId !== "string" || sessionId === "") throw new Error("恢复需要会话缓存 ID（sessionId）");
		if (this.adapter.binary === null) throw new Error("herdr binary not found — 无法使用 herdr 模式");
		const resume = rawPane ? null : HerdrAgentRegistry.resumeArgs(engine, sessionId);
		if (resume === null && !rawPane) throw new Error(`engine "${engine}" 没有对应的恢复命令`);
		const targetCwd = typeof cwd === "string" && cwd !== "" ? cwd : this.baseCwd;
		if (this.onSpawn !== null) {
			try {
				this.onSpawn(targetCwd);
			} catch {}
		}
		const { workspaceId, rootPaneId, created: wsCreated } = await this.ensureWorkspace(targetCwd);
		let paneId = await this.findFreePane(workspaceId, targetCwd);
		if (paneId === null) {
			const panes = await this.adapter.paneList(workspaceId);
			const direction = ((panes?.panes?.length ?? 1) % 2 === 0) ? "down" : "right";
			const split = await this.adapter.paneSplit(rootPaneId, direction, targetCwd);
			paneId = split?.pane?.pane_id ?? null;
			if (paneId === null) throw new Error("无法在 herdr 中创建面板（pane split 失败）");
		}
		const agentId = randomUUID().slice(0, 8);
		const herdrName = slugHerdrName(agentId);
		const handle = {
			id: agentId,
			herdrName,
			paneId,
			workspaceId,
			type: engine,
			name: (name ?? engine).trim() || engine,
			role: "",
			skills: [],
			cwd: targetCwd,
			// 恢复时会话缓存 ID 一开始就确定 → 立即写入 agent.conf。
			sessionId,
			nativeSession: sessionId,
			_sessionSource: "explicit",
			dshSessionId: "",
			sessionName: "",
			restored: true,
			pid: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			briefing: "none",
			status: "unknown",
			exited: false,
			exitCode: null,
			_wsCreated: wsCreated === true,
			_rawPane: rawPane === true
		};
		this.agents.set(agentId, handle);
		this.notify();
		try {
			if (rawPane) {
				const bin = resolveEngineBinary(engine);
				if (bin === null) throw new Error(`引擎 "${engine}" 未安装（未在 PATH / ~/.local/bin / ~/.opencode/bin / ~/.nvm/versions/node/*/bin 找到）`);
				handle.status = "starting";
				this.updated(handle);
				await this.adapter.paneSendText(paneId, `${bin} --resume ${sessionId}`);
				await this.adapter.paneSendKeys(paneId, "Enter");
				handle.status = "working";
			} else {
				const started = await this.adapter.agentStart(herdrName, kind, paneId, { timeoutMs: 60000, args: resume });
				handle.status = mapStatus(started?.agent?.agent_status);
			}
		} catch (error) {
			if (!rawPane && error instanceof HerdrError && error.code === HERDR_ERRORS.AGENT_NOT_READY) {
				handle.status = "blocked";
				const resolved = await this.autoAnswer(handle, 4);
				if (resolved) {
					handle.status = mapStatus((await this.adapter.agentGet(herdrName).catch(() => null))?.agent?.agent_status) || "idle";
				}
			} else {
				this.agents.delete(agentId);
				this.notify();
				this.markConfDirty(targetCwd);
				throw error;
			}
		}
		this.updated(handle);
		this.markConfDirty(targetCwd);
		return handle;
	}

	// -------------------------------------------------- agent.conf（实时窗口登记）
	/**
	 * agent.conf 实时记录每个 herdr 窗口的关键信息，供工具/智能体/外部脚本
	 * 读取「会话即窗口」映射：窗口 id（paneId）、窗口类型（claude/codex/…）、
	 * 会话缓存 ID（sessionId）。写入位置：<cwd>/.deepseek/agent.conf。
	 */
	agentConfPath(cwd) {
		return join(cwd, this.memoryDir, "agent.conf");
	}
	markConfDirty(cwd) {
		if (typeof cwd !== "string" || cwd === "") return;
		this._confDirty.add(cwd);
		if (this._confTimer === null) {
			this._confTimer = setTimeout(() => {
				this._confTimer = null;
				const dirties = [...this._confDirty];
				this._confDirty.clear();
				for (const d of dirties) this.writeAgentConf(d).catch(() => {});
			}, 300);
		}
	}
	/** 写一份项目的 agent.conf：该 cwd 下所有存活窗口的 paneId/type/sessionId。 */
	async writeAgentConf(cwd) {
		if (typeof cwd !== "string" || cwd === "") return;
		const agents = [...this.agents.values()]
			.filter((h) => !h.exited && h.cwd === cwd)
			.map((h) => ({
				agentId: h.id,
				herdrName: h.herdrName ?? "",
				paneId: h.paneId ?? "",
				type: h.type,
				name: h.name,
				sessionId: (h.sessionId ?? "") !== "" ? h.sessionId : (h.nativeSession ?? ""),
				status: h.status,
				restored: h.restored === true,
				updatedAt: h.updatedAt
			}))
			.sort((a, b) => a.paneId.localeCompare(b.paneId));
		const conf = {
			version: 1,
			updatedAt: new Date().toISOString(),
			agents
		};
		const dir = join(cwd, this.memoryDir);
		try {
			mkdirSync(dir, { recursive: true });
			const target = this.agentConfPath(cwd);
			const tmp = `${target}.tmp`;
			writeFileSync(tmp, JSON.stringify(conf, null, 2) + "\n", "utf8");
			writeFileSync(target, JSON.stringify(conf, null, 2) + "\n", "utf8");
			try { await import("node:fs").then((fs) => fs.rmSync(tmp, { force: true })); } catch {}
		} catch {}
	}

	/**
	 * 探测运行中窗口的会话缓存 ID。
	 * 来源分层（_sessionSource）：
	 *   "explicit" — 恢复会话，ID 一开始就确定，永不重探；
	 *   "herdr"    — herdr agent_session 上报（opencode/codex 集成），权威，直接同步；
	 *   "scanner"  — SessionScanner 兜底（claude 集成不上报），只认「窗口启动之后」
	 *                （time >= createdAt）的最新会话，绝不取全局最新（否则会把上一个
	 *                窗口的旧会话误配给新窗口 → 新会话卡片一直灰色）；每窗口 8s 节流
	 *                重探，探测到更新的归属会话会自愈更新。
	 */
	async detectSessionId(handle) {
		if (handle === void 0 || handle.exited) return "";
		if (handle._sessionSource === "explicit") return handle.sessionId ?? "";
		const native = handle.nativeSession ?? "";
		if (native !== "" && handle._sessionSource === "herdr") {
			if (handle.sessionId !== native) {
				handle.sessionId = native;
				this.updated(handle);
				this.markConfDirty(handle.cwd);
			}
			return native;
		}
		const now = Date.now();
		if (handle._detectAt !== void 0 && now - handle._detectAt < 8000) return handle.sessionId ?? "";
		handle._detectAt = now;
		if (this.scanner === null || typeof handle.cwd !== "string" || handle.cwd === "") return handle.sessionId ?? "";
		try {
			const all = await this.scanner.list(handle.cwd);
			// 只认窗口出生之后（含 5s 容差）的会话：新建窗口自己的新会话必然满足；
			// 上一个窗口的旧会话（mtime 早于 createdAt）被排除。
			const bornAfter = (all ?? []).find((s) => s.engine === handle.type && (s.time ?? 0) >= (handle.createdAt ?? 0) - 5000);
			const sid = bornAfter?.id ?? "";
			if (sid !== "" && handle.sessionId !== sid) {
				handle.sessionId = sid;
				handle.nativeSession = sid;
				handle._sessionSource = "scanner";
				this.updated(handle);
				this.markConfDirty(handle.cwd);
			}
			return handle.sessionId ?? "";
		} catch {
			return handle.sessionId ?? "";
		}
	}

	async compactSession(id) {
		const handle = this.requireHandle(id);
		if (handle._rawPane === true) {
			try {
				await this.adapter.paneSendText(handle.paneId, "/compact");
				await this.adapter.paneSendKeys(handle.paneId, "Enter");
			} catch {}
			handle.updatedAt = Date.now();
			return;
		}
		try {
			await this.adapter.agentPrompt(handle.herdrName, "/compact", { wait: false });
		} catch {}
		handle.updatedAt = Date.now();
	}

	// -------------------------------------------------- legacy-only stubs
	// herdr 自身持久化进程与会话，无需 agents.json 保存/恢复。
	scanCwd() { return []; }
	restoreSaved() { return null; }
	forgetSaved() { return null; }
	restoreState() {}
	newSession(id) {
		const handle = this.get(id);
		if (handle !== void 0 && !handle.exited) {
			if (handle._rawPane === true) {
				this.adapter.paneSendText(handle.paneId, "/clear").then(() => this.adapter.paneSendKeys(handle.paneId, "Enter")).catch(() => {});
				return;
			}
			this.adapter.agentPrompt(handle.herdrName, "/clear", { wait: false }).catch(() => {});
		}
	}
	allCacheInfo() { return []; }
	compressCache() { return []; }

	// ------------------------------------------------------------ internals
	requireHandle(id) {
		const handle = this.agents.get(id);
		if (handle === void 0) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return handle;
	}
	updated(handle) {
		handle.updatedAt = Date.now();
		this.notify();
	}
	notify() {
		const snapshot = this.snapshotKey();
		if (snapshot === this._lastSnapshot) return;
		this._lastSnapshot = snapshot;
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch {}
		}
	}
	snapshotKey() {
		return JSON.stringify([...this.agents.values()].map((h) => `${h.id}:${h.status}:${h.exited ? 1 : 0}`));
	}

	/** Poll herdr agent list and merge into the local cache. */
	async refresh() {
		if (this._polling) return;
		this._polling = true;
		try {
			const data = await this.adapter.agentList();
			const entries = Array.isArray(data?.agents) ? data.agents : [];
			const seen = new Set();
			for (const e of entries) {
				const paneId = e.pane_id ?? e.pane ?? null;
				const herdrName = e.name ?? e.id ?? paneId;
				if (herdrName === null) continue;
				let handle = [...this.agents.values()].find((h) => h.herdrName === herdrName || (paneId !== null && h.paneId === paneId));
				if (handle === void 0) {
					// 接管 herdr 空间中已存在的智能体（手动启动/其它来源）：
					// 雷达监控整个 herdr 空间，而非仅本插件创建的 agent。
					const status = mapStatus(e.agent_status ?? e.status);
					handle = {
						id: herdrName,
						herdrName,
						paneId: paneId ?? "",
						workspaceId: e.workspace_id ?? "",
						type: e.agent ?? e.kind ?? "agent",
						name: e.terminal_title_stripped ?? e.name ?? herdrName,
						role: "",
						skills: [],
						cwd: typeof e.cwd === "string" && e.cwd !== "" ? e.cwd : this.baseCwd,
						sessionId: e.agent_session?.value ?? "",
						sessionName: "",
						nativeSession: e.agent_session?.value ?? "",
						_sessionSource: e.agent_session?.value ? "herdr" : "",
						restored: false,
						pid: null,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						briefing: "none",
						status,
						exited: false,
						exitCode: null,
						external: true,
						_seenAt: Date.now(),
						_stats: null,
						_statsAt: 0
					};
					this.agents.set(handle.id, handle);
					this.notify();
				}
				seen.add(handle.id);
				if (handle._seenAt === void 0) handle._seenAt = Date.now();
				const status = mapStatus(e.agent_status ?? e.status);
				let changed = false;
				if (handle.status !== status) {
					handle.status = status;
					handle.updatedAt = Date.now();
					changed = true;
				}
				if (typeof e.cwd === "string" && e.cwd !== "" && handle.cwd !== e.cwd) {
					handle.cwd = e.cwd;
					changed = true;
				}
				if (typeof e.pane_id === "string" && e.pane_id !== "" && handle.paneId !== e.pane_id) {
					handle.paneId = e.pane_id;
					changed = true;
				}
				if (typeof e.workspace_id === "string" && e.workspace_id !== "" && handle.workspaceId !== e.workspace_id) {
					handle.workspaceId = e.workspace_id;
					changed = true;
				}
				// 会话缓存 ID（会话即窗口对接依据）：herdr agent_session 是最权威的实时来源。
				if (e.agent_session?.value) {
					if (handle.nativeSession !== e.agent_session.value) {
						handle.nativeSession = e.agent_session.value;
						changed = true;
					}
					if (handle.sessionId !== e.agent_session.value) {
						handle.sessionId = e.agent_session.value;
						changed = true;
					}
					if (handle._sessionSource !== "herdr") {
						handle._sessionSource = "herdr";
						changed = true;
					}
				}
				if (changed) this.notify();
				// 状态/会话变化 → 刷新 agent.conf；所有存活窗口都做节流会话归属
				// 重探（8s/窗口），让探测到旧会话的窗口能自愈到真正的新会话。
				if (changed) this.markConfDirty(handle.cwd);
				if (!handle.exited) this.detectSessionId(handle).catch(() => {});
			}
			const now = Date.now();
			for (const [id, handle] of this.agents) {
				if (seen.has(id)) continue;
				// 裸 pane 智能体（codebuddy）不在 herdr agentList 里（无 kind 不会
				// 被 herdr 识别为 agent）→ 用 paneRead + 内容判定做持续存活监控：
				//   • paneRead 抛错 → pane 已关 → 宽限期后标 exited；
				//   • 读成功但输出出现会话结束摘要 / shell 提示符（codebuddy 已退出，
				//     pane 回到 shell）→ 立即标 exited（原实现只看 pane 是否还在，
				//     退出后 pane 仍在 → 一直误报运行中）；
				//   • 只有 CLI 已就绪（会话文件出现，启动即写 0 字节文件）后才做内容
				//     判定，避免启动窗口（命令已发、TUI 未起）把 shell 提示符误判为退出。
				if (handle._rawPane === true) {
					if (!handle.exited) {
						let text = "";
						let readOk = true;
						try {
							text = await this.adapter.paneRead(handle.paneId, 20);
						} catch {
							readOk = false;
						}
						if (!readOk) {
							if (handle._seenAt === void 0) handle._seenAt = now;
							if (now - handle._seenAt >= EXIT_GRACE_MS) {
								handle.exited = true;
								handle.status = "exited";
								handle.updatedAt = now;
								this.markConfDirty(handle.cwd);
								this.notify();
							}
							continue;
						}
						if (this._rawPaneSessionFile(handle) !== null && this._rawPaneExited(text)) {
							handle.exited = true;
							handle.status = "exited";
							handle.updatedAt = now;
							this.markConfDirty(handle.cwd);
							this.notify();
						} else {
							handle._seenAt = now;
						}
						continue;
					}
					continue;
				}
				// 退出判定要求先见过一次（避免启动期/恢复期误标 exited）。
				if (handle._seenAt === void 0 || now - handle._seenAt < EXIT_GRACE_MS) continue;
				if (!handle.exited) {
					handle.exited = true;
					handle.status = "exited";
					handle.updatedAt = now;
					this.markConfDirty(handle.cwd);
					this.notify();
				}
				// 外部智能体退出一段时间后从缓存移除（防幽灵累积）。
				if (handle.external === true && now - handle.updatedAt > EXTERNAL_PRUNE_MS) {
					this.agents.delete(id);
					this.markConfDirty(handle.cwd);
					this.notify();
				}
			}
			this.maybeRefreshStats();
		} catch (error) {
			if (error instanceof HerdrError && (error.code === HERDR_ERRORS.SERVER_DOWN || error.code === HERDR_ERRORS.NOT_FOUND)) {
				for (const handle of this.agents.values()) {
					if (!handle.exited && handle.status !== "unknown") {
						handle.status = "unknown";
						handle.updatedAt = Date.now();
						this.notify();
					}
				}
			}
		} finally {
			this._polling = false;
		}
	}

	/** Find the workspace whose panes live in `cwd`; create it when missing. */
	async ensureWorkspace(cwd) {
		const cached = this._workspaceCache.get(cwd);
		if (cached !== void 0) return cached;
		const wss = await this.adapter.workspaceList();
		for (const ws of wss?.workspaces ?? []) {
			const panes = await this.adapter.paneList(ws.workspace_id);
			const hit = (panes?.panes ?? []).find((p) => p.cwd === cwd);
			if (hit !== void 0) {
				const entry = { workspaceId: ws.workspace_id, rootPaneId: hit.pane_id, created: false };
				this._workspaceCache.set(cwd, entry);
				return entry;
			}
		}
		const created = await this.adapter.workspaceCreate(cwd, basename(cwd));
		const entry = { workspaceId: created?.workspace?.workspace_id, rootPaneId: created?.root_pane?.pane_id, created: true };
		if (entry.workspaceId === void 0) throw new Error("herdr workspace create 失败");
		this._workspaceCache.set(cwd, entry);
		return entry;
	}

	/** A pane in this workspace, at the right cwd, without an agent / not ours. */
	async findFreePane(workspaceId, cwd) {
		const panes = await this.adapter.paneList(workspaceId);
		const owned = new Set([...this.agents.values()].map((h) => h.paneId));
		for (const p of panes?.panes ?? []) {
			if (p.cwd !== cwd) continue;
			if (owned.has(p.pane_id)) continue;
			const hasAgent = typeof p.agent_status === "string" && p.agent_status !== "unknown";
			if (!hasAgent) return p.pane_id;
		}
		return null;
	}

	/** Role/skill briefing — same contract wording as the legacy registry. */
	briefingText(handle) {
		const lines = [
			`[dsh-agent-commander] 你已被总指挥以「${handle.name}」的身份启动（引擎：${handle.type}，herdr 面板 ${handle.paneId}）。`,
			`职责定义：${handle.role}`,
			"团队协作协议（必须遵守）：",
			"1. 先读取工作目录 .deepseek/ 下的 memory.md、task-board.md、experience.md，了解团队上下文、进行中的任务、历史经验与 SQLite 记忆层用法。",
			"2. 完成任务后，在 .deepseek/task-board.md 和 SQLite 的 tasks 表中把对应任务状态更新为 ✅/❌ 并写明结果。",
			"3. 重要产出写入 .deepseek/handoffs/（文件名建议 .deepseek/handoffs/<你的名字>-<主题>.md），并在 handoffs 表登记。",
			"4. 工作结束后，在 .deepseek/experience.md 和 SQLite memory 表（namespace='experience'）中沉淀经验：结果、经验教训、踩坑记录、可复用的模式。",
			"5. 向总指挥（DeepSeek）汇报：做了什么、结果如何、下一步建议。"
		];
		for (const skill of handle.skills) lines.push(`请先阅读并遵循技能文件：${skill}`);
		return lines.join("\n");
	}

	/** Inject the briefing as the agent's first task (async; waits for idle). */
	/**
	 * 自动应答确认弹窗（claude 文件夹信任 / 通用 y/n 等）。
	 * 读取 visible 输出，命中已知弹窗模式就发送对应按键（回车 / y+回车），
	 * 直到 agent 脱离 blocked 或达到尝试上限。返回是否已就绪。
	 */
	async autoAnswer(handle, attempts = 4) {
		for (let i = 0; i < attempts; i++) {
			let text = "";
			try {
				text = await this.adapter.agentRead(handle.herdrName, 15, "visible");
			} catch {
				break;
			}
			const t = String(text ?? "").replace(/\s+/g, "");
			const hit = AUTO_ANSWER_PATTERNS.find((p) => p.re.test(t));
			if (hit === void 0) break;
			try {
				if (hit.y === true) {
					await this.adapter.paneSendText(handle.paneId, "y");
					await this.adapter.paneSendKeys(handle.paneId, "Enter");
				} else {
					await this.adapter.agentSendKeys(handle.herdrName, "enter");
				}
			} catch {
				break;
			}
			await sleep(1200);
			const info = await this.adapter.agentGet(handle.herdrName).catch(() => null);
			const st = mapStatus(info?.agent?.agent_status);
			if (st === "idle" || st === "working" || st === "done") return true;
		}
		return false;
	}

	injectBriefing(handle, briefing) {
		(async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (handle.exited) return;
				try {
					// 启动期就绪前可能挂着未被 herdr 判为 blocked 的确认弹窗：
					// 先试探性自动应答一次（无命中则不动作）。
					if (handle.status === "blocked" || handle.status === "unknown" || handle.status === "idle") {
						await this.autoAnswer(handle, 2);
					}
					// 等 agent 就绪（idle/done/blocked 任一），unknown/启动期
					// 的 prompt 会被吞或触发 agent_prompt_stalled。
					await this.adapter.agentWait(handle.herdrName, { until: ["idle", "done", "blocked"], timeoutMs: 120000 });
					if (handle.exited) return;
					await this.adapter.agentPrompt(handle.herdrName, briefing, { wait: true, timeoutMs: 120000 });
					handle.briefing = "done";
					this.updated(handle);
					return;
				} catch (error) {
					if (error instanceof HerdrError && error.code === HERDR_ERRORS.AGENT_BLOCKED) {
						handle.status = "blocked";
						this.updated(handle);
						// 自动点确认（不再卡在灰色界面），成功后重试注入。
						const resolved = await this.autoAnswer(handle, 4);
						if (resolved) continue;
						return; // 仍 blocked：等 agent_approve 手动确认
					}
					// 其他错误（stalled/timeout/网络）：重试一次
				}
			}
			handle.briefing = "pending";
			this.updated(handle);
		})();
	}

	// ------------------------------------------------- 裸 pane 启动监控（codebuddy）
	/**
	 * 裸 pane 引擎（codebuddy）的启动监控——直接读 pane 输出，完全符合
	 * 「新建后监控输出 → 该点 yes 时点 yes → 一直协助到注入 skill」的流程：
	 *   1. 轮询 paneRead，命中 AUTO_ANSWER_PATTERNS 的确认弹窗（文件夹信任等）
	 *      → 自动回车 / y+回车（该点 yes 时点 yes）；
	 *   2. 启动窗口过后注入角色/技能简报（paneSendText + Enter）；
	 *   3. 在 codebuddy 会话文件（~/.codebuddy/projects/<slug>/）里验证简报
	 *      落地（出现 "[dsh-agent-commander]" 用户消息）→ briefing=done，
	 *      状态转 working，并经 WS 推送让客户端刷新会话历史；
	 *   4. 后台执行、有总时限，超时降级 briefing=pending 但不失败。
	 */
	async monitorRawPane(handle, briefing) {
		const marker = "[dsh-agent-commander]";
		const startedAt = Date.now();
		const CAP_MS = 120000;
		let answeredPrompts = 0;
		let injected = false;
		let firstFailureAt = null;
		while (Date.now() - startedAt < CAP_MS) {
			if (handle.exited) return;
			let raw = "";
			try {
				raw = await this.adapter.paneRead(handle.paneId, 80);
				firstFailureAt = null;
			} catch {
				// pane 可能仍在创建/瞬断：记首次失败时间，持续 10s 失败则放弃
				if (firstFailureAt === null) firstFailureAt = Date.now();
				if (Date.now() - firstFailureAt > 10000) break;
				await sleep(1000);
				continue;
			}
			const t = stripAnsi(String(raw ?? "")).replace(/\s+/g, "");
			// 1) 启动期确认弹窗自动应答（注入前才自动应答，注入后的权限提问交 agent_approve）
			if (!injected && answeredPrompts < 8) {
				const hit = AUTO_ANSWER_PATTERNS.find((p) => p.re.test(t));
				if (hit !== void 0) {
					answeredPrompts++;
					try {
						if (hit.y === true) {
							await this.adapter.paneSendText(handle.paneId, "y");
							await this.adapter.paneSendKeys(handle.paneId, "Enter");
						} else {
							await this.adapter.paneSendKeys(handle.paneId, "Enter");
						}
					} catch {}
					await sleep(1200);
					continue;
				}
			}
			// 2) 注入简报：等 CLI 真正就绪再注入。就绪信号 = codebuddy 启动即写
			//    会话文件（实测启动时先写一个 0 字节 <sessionId>.jsonl），文件出现
			//    说明 TUI 已接管输入；固定延时不可靠（pane 里 codebuddy 要 ~8s 才起来）。
			if (!injected && Date.now() - startedAt > 3000 && this._rawPaneSessionFile(handle) !== null) {
				injected = true;
				try {
					await this.adapter.paneSendText(handle.paneId, briefing);
					await this.adapter.paneSendKeys(handle.paneId, "Enter");
				} catch {}
			}
			// 3) 验证落地：会话文件出现含 marker 的用户消息 → 完成
			if (injected && this._rawPaneBriefingLanded(handle, marker)) {
				handle.briefing = "done";
				handle.status = "working";
				this.updated(handle);
				return;
			}
			await sleep(1200);
		}
		handle.briefing = handle.briefing === "done" ? "done" : "pending";
		handle.status = "working";
		this.updated(handle);
	}

	/** 裸 pane 引擎「本次启动」对应的最新 codebuddy 会话文件（mtime >= createdAt-5s）。
	 *  启动即写（0 字节也算）→ 既是就绪信号，也是注入验证的读取对象。 */
	_rawPaneSessionFile(handle) {
		try {
			const dir = join(homedir(), ".codebuddy", "projects", String(handle.cwd ?? "").replace(/^\/+/, "").replace(/[^a-zA-Z0-9_]+/g, "-"));
			if (!existsSync(dir)) return null;
			const bornAfter = (handle.createdAt ?? 0) - 5000;
			let best = null;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".jsonl")) continue;
				const full = join(dir, f);
				try {
					const st = statSync(full);
					if (st.mtimeMs < bornAfter) continue;
					if (best === null || st.mtimeMs > best.mtimeMs) best = full;
				} catch {}
			}
			return best;
		} catch {
			return null;
		}
	}

	/** 裸 pane 简报落地验证：最新 codebuddy 会话文件里出现含 marker 的用户消息。 */
	_rawPaneBriefingLanded(handle, marker) {
		const best = this._rawPaneSessionFile(handle);
		if (best === null) return false;
		try {
			return readFileSync(best, "utf8").slice(-131072).includes(marker);
		} catch {
			return false;
		}
	}

	/**
	 * 裸 pane 内容级退出判定：codebuddy 已退出时 pane 仍在（回到 shell），
	 * 单看 pane 是否存在会一直误报「运行中」。两个可靠信号（实测）：
	 *   1. codebuddy 会话结束摘要（/exit、exit 退出时打印）：
	 *      "Total duration (wall)…" / "To resume this session: codebuddy --resume=…"
	 *   2. shell 提示符回到输出末尾（zsh 默认：user@host 目录 %；ctrl+c 强杀
	 *      无摘要时靠这个）：`^\s*user@host dir %$`
	 */
	_rawPaneExited(text) {
		const t = String(text ?? "");
		if (/To resume this session:|resume last session:|Total duration \(wall\)/i.test(t)) return true;
		if (/(^|\n)\s*[^\s@\n]+@[^\s@\n]+\s+\S.*[%$#]\s*$/m.test(t)) return true;
		return false;
	}

	shutdown() {
		clearInterval(this._pollTimer);
	}

	// -------------------------------------------------- token/任务统计（尽力而为）
	/**
	 * 计算智能体的 token 消耗 / 成本 / 任务数 / 当前任务（缓存 30s）。
	 * 数据源：opencode → opencode.db(SQLite)；claude → ~/.claude/projects/<cwd-slug>/ 最新 jsonl。
	 * 取不到返回 null（不阻塞、不报错）。
	 */
	async statsOf(handle) {
		if (handle.exited) return null;
		const now = Date.now();
		if (handle._statsAt !== void 0 && now - (handle._statsAt ?? 0) < STATS_CACHE_MS) return handle._stats ?? null;
		let value = null;
		try {
			if (handle.type === "opencode") value = await this.opencodeStats(handle);
			else if (handle.type === "claude") value = await this.claudeStats(handle);
		} catch {}
		handle._stats = value;
		handle._statsAt = Date.now();
		return value;
	}

	async opencodeStats(handle) {
		const sid = handle.nativeSession;
		if (typeof sid !== "string" || sid === "") return null;
		if (!existsSync(OPENCODE_DB)) return null;
		const q = (sql) => execFileAsync("/usr/bin/sqlite3", [OPENCODE_DB, sql], { timeout: 8000 });
		const esc = sid.replace(/'/g, "''");
		const row = await q(`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, title FROM session WHERE id='${esc}'`);
		const [cost, tIn, tOut, tReason, tCache, title] = (row ?? "").split("|");
		if (tIn === void 0) return null;
		const tasks = Number(await q(`SELECT COUNT(*) FROM message WHERE session_id='${esc}' AND json_extract(data,'$.role')='user'`) || 0);
		let currentTask = "";
		try {
			const last = await q(
				`SELECT p.data FROM part p JOIN message m ON m.id=p.message_id ` +
				`WHERE p.session_id='${esc}' AND json_extract(p.data,'$.type')='text' ` +
				`AND json_extract(m.data,'$.role')='user' ORDER BY p.time_created DESC LIMIT 1`
			);
			currentTask = (JSON.parse(last ?? "{}").text ?? "").trim().slice(0, 120);
		} catch {}
		return {
			tokens: (Number(tIn) || 0) + (Number(tOut) || 0) + (Number(tReason) || 0),
			tokensInput: Number(tIn) || 0,
			tokensOutput: Number(tOut) || 0,
			cost: Number(cost) > 0 ? Number(cost) : null,
			tasks,
			currentTask,
			title: typeof title === "string" && title !== "" ? title.slice(0, 60) : null
		};
	}

	async claudeStats(handle) {
		// claude 的 project 目录名 = cwd 中所有非字母数字字符替换为 "-"。
		const slug = handle.cwd.replace(/[^a-zA-Z0-9]+/g, "-");
		const dir = join(CLAUDE_PROJECTS_DIR, slug);
		if (!existsSync(dir)) return null;
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({ f, mtimeMs: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		if (files.length === 0) return null;
		// 取最新会话文件近似当前 agent（claude 的 herdr 集成不总是上报 session id）。
		const full = join(dir, files[0].f);
		let inTok = 0;
		let outTok = 0;
		let tasks = 0;
		let currentTask = "";
		for (const line of readFileSync(full, "utf8").split("\n")) {
			if (line === "") continue;
			let d;
			try {
				d = JSON.parse(line);
			} catch {
				continue;
			}
			if (d?.type === "assistant") {
				const u = d.message?.usage;
				if (u && typeof u === "object") {
					inTok += u.input_tokens ?? u.cache_creation_input_tokens ?? 0;
					outTok += u.output_tokens ?? 0;
				}
			} else if (d?.type === "user" && d.message?.tool_use_id === void 0) {
				const c = d.message?.content;
				const texts = Array.isArray(c)
					? c.filter((p) => typeof p === "string" || p?.type === "text")
						.map((p) => (typeof p === "string" ? p : p.text ?? ""))
						.join(" ")
						.trim()
					: typeof c === "string"
						? c.trim()
						: "";
				if (texts !== "") {
					tasks += 1;
					currentTask = texts;
				}
			}
		}
		return {
			tokens: inTok + outTok,
			tokensInput: inTok,
			tokensOutput: outTok,
			cost: (inTok + outTok) > 0 ? ((inTok + outTok) / 1e6) * CLAUDE_COST_PER_1M : null,
			tasks,
			currentTask: currentTask.slice(0, 120),
			title: null
		};
	}

	/** 雷达轮询时按需刷新统计（30s 缓存，异步不阻塞列表）。 */
	maybeRefreshStats() {
		const now = Date.now();
		for (const handle of this.agents.values()) {
			if (handle.exited) continue;
			if (handle._statsAt !== void 0 && now - (handle._statsAt ?? 0) < STATS_CACHE_MS) continue;
			this.statsOf(handle).then(() => {
				this.notify();
			}).catch(() => {});
		}
	}
}

export { HerdrAdapter, HerdrError, HERDR_ERRORS };
