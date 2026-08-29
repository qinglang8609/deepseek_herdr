// ============================================================================
// terminal-registry.js — 终端宿主模式的智能体注册表。
//
// 智能体 = 系统终端窗口里运行的引擎进程（Terminal.app / Ghostty / iTerm2）。
// 注册表负责：拉起终端（pidfile 捕获 PID）→ 2s 轮询进程存活（终端被关 →
// 进程消失 → 卡片变灰 exited）→ agent_* 工具对接（send/approve 走系统按键
// 注入，signal 走 kill）。会话历史（恢复/删除）见 session-scanner.js。
//
// 状态语义（终端模式简化）：运行中(working/绿) | 已退出(exited/灰)。
// ============================================================================

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalLauncher, shq, waitForPidfile } from "./terminal-launcher.js";
import { isAlive, sendSignal } from "./process-monitor.js";
import { activateApp, typeTextAndEnter, pressKey } from "./keystroke.js";

export const ENGINE_TYPES = ["claude", "opencode", "codex", "codebuddy"];

const POLL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 引擎启动/恢复命令模板。binary 用绝对路径（resolve 后注入）。 */
const ENGINE_COMMANDS = {
	claude: {
		start: (bin, briefing) => `${bin}${briefing ? "" : ""}`,
		resume: (bin, id) => `${bin} --resume ${shq(id)}`,
		compact: "/compact",
		clear: "/clear",
		terminalName: "Terminal"
	},
	opencode: {
		start: (bin, briefing) => (briefing ? `${bin} --prompt ${shq(briefing)}` : bin),
		resume: (bin, id) => `${bin} -s ${shq(id)}`,
		compact: null,
		clear: "/new",
		terminalName: "Terminal"
	},
	codex: {
		start: (bin, briefing) => bin,
		resume: (bin, id) => `${bin} resume ${shq(id)}`,
		compact: null,
		clear: "/new",
		terminalName: "Terminal"
	},
	codebuddy: {
		start: (bin, briefing) => bin,
		resume: (bin, id) => `${bin} --resume ${shq(id)}`,
		compact: "/compact",
		clear: "/clear",
		terminalName: "Terminal"
	}
};

/** 解析引擎二进制：PATH + 常见目录。 */
export function resolveEngineBinary(engine) {
	const names = { claude: "claude", opencode: "opencode", codex: "codex", codebuddy: "codebuddy" };
	const name = names[engine];
	if (!name) return null;
	const candidates = [];
	for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) candidates.push(join(dir, name));
	candidates.push(
		join(process.env.HOME ?? "", ".local", "bin", name),
		join(process.env.HOME ?? "", ".opencode", "bin", name),
		"/opt/homebrew/bin/" + name,
		"/usr/local/bin/" + name
	);
	for (const c of candidates) {
		try {
			if (existsSync(c)) return c;
		} catch {}
	}
	return null;
}

export class TerminalAgentRegistry {
	constructor(opts = {}) {
		this.maxAgents = opts.maxAgents ?? 8;
		this.allowedSignals = Array.isArray(opts.allowedSignals) && opts.allowedSignals.length > 0 ? [...opts.allowedSignals] : ["SIGINT", "SIGTSTP", "SIGTERM"];
		this.transcriptLimit = opts.transcriptLimit ?? (1 << 20);
		this.memoryDir = opts.memoryDir ?? ".deepseek";
		this.baseCwd = opts.baseCwd ?? process.cwd();
		this.onSpawn = typeof opts.onSpawn === "function" ? opts.onSpawn : null;
		this.projectRootOf = typeof opts.projectRootOf === "function" ? opts.projectRootOf : null;
		this.terminalApp = opts.terminalApp ?? "auto";
		this.launcher = new TerminalLauncher(this.terminalApp);
		this.binaries = {};
		for (const engine of ENGINE_TYPES) {
			this.binaries[engine] = resolveEngineBinary(engine);
		}
		this.agents = new Map(); // id → handle
		this.listeners = new Set();
		this._polling = false;
		this._lastSnapshot = "";
		this._pollTimer = setInterval(() => { this.poll().catch(() => {}); }, POLL_MS);
		this.poll().catch(() => {});
	}

	// ---------------------------------------------------------------- meta
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
			sessionName: handle.sessionName,
			workspaceId: handle.workspaceId,
			restored: handle.restored === true,
			briefing: handle.briefing ?? "none",
			external: false,
			terminalApp: handle.terminalApp ?? null,
			createdAt: handle.createdAt,
			updatedAt: handle.updatedAt,
			stats: null
		};
	}

	// ----------------------------------------------------------- sync reads
	list() {
		return [...this.agents.values()].map((h) => this.meta(h));
	}
	listByCwd(cwd) {
		return [...this.agents.values()].filter((h) => h.cwd === cwd).map((h) => this.meta(h));
	}
	get(id) {
		return this.agents.get(id);
	}
	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	// ----------------------------------------------------------- creation
	async create({ type, name, role, skills, cwd, id, sessionId, sessionName }) {
		if (this.agents.size >= this.maxAgents) throw new Error(`agent limit reached (${this.maxAgents})`);
		if (!ENGINE_TYPES.includes(type)) throw new Error(`unknown engine "${type}" — allowed: ${ENGINE_TYPES.join(", ")}`);
		const binary = this.binaries[type];
		if (binary === null) throw new Error(`引擎 "${type}" 未安装（未在 PATH / ~/.local/bin / ~/.opencode/bin 找到）`);
		const targetCwd = typeof cwd === "string" && cwd !== "" ? cwd : this.baseCwd;
		if (this.onSpawn !== null) {
			try {
				this.onSpawn(targetCwd);
			} catch {}
		}
		const agentId = typeof id === "string" && id !== "" ? id : randomUUID().slice(0, 8);
		const trimmedRole = (role ?? "").trim();
		const skillList = Array.isArray(skills) ? skills.filter((s) => typeof s === "string") : [];
		const briefing = trimmedRole !== "" || skillList.length > 0 ? this.briefingText({ name: (name ?? type).trim() || type, type, role: trimmedRole, skills: skillList }) : "";
		const pidfile = join(tmpdir(), `dsh-${agentId}.pid`);
		const cmd = ENGINE_COMMANDS[type].start(binary, briefing && type === "opencode" ? briefing : "");
		const handle = {
			id: agentId,
			type,
			name: (name ?? type).trim() || type,
			role: trimmedRole,
			skills: skillList,
			cwd: targetCwd,
			sessionId: typeof sessionId === "string" ? sessionId : "",
			sessionName: typeof sessionName === "string" ? sessionName : "",
			workspaceId: typeof workspaceId === "string" ? workspaceId : "",
			restored: false,
			pid: null,
			pidfile,
			terminalApp: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			briefing: briefing !== "" ? "pending" : "none",
			status: "starting",
			exited: false,
			exitCode: null
		};
		this.agents.set(agentId, handle);
		this.notify();
		try {
			const launched = await this.launcher.launch({ cwd: targetCwd, command: cmd, pidfile });
			handle.terminalApp = launched.app;
			const pid = await waitForPidfile(pidfile, 25000);
			handle.pid = pid;
			handle.status = pid !== null ? "working" : "unknown";
		} catch (error) {
			this.agents.delete(agentId);
			this.notify();
			throw error;
		}
		this.updated(handle);
		// 简报注入（异步）：opencode 已随 --prompt 注入；claude/codex 用按键注入。
		if (handle.briefing === "pending" && type !== "opencode") {
			this.injectBriefing(handle, briefing);
		}
		return handle;
	}

	/** 恢复一个历史会话：拉起终端执行引擎 resume 命令。返回新 handle。 */
	async restoreSession({ engine, sessionId: sid, cwd, name }) {
		const binary = this.binaries[engine];
		if (!binary) throw new Error(`引擎 "${engine}" 未安装`);
		const targetCwd = typeof cwd === "string" && cwd !== "" ? cwd : this.baseCwd;
		const cmd = ENGINE_COMMANDS[engine].resume(binary, sid);
		const agentId = randomUUID().slice(0, 8);
		const pidfile = join(tmpdir(), `dsh-${agentId}.pid`);
		const handle = {
			id: agentId,
			type: engine,
			name: typeof name === "string" && name !== "" ? name : `${engine}-resume`,
			role: "",
			skills: [],
			cwd: targetCwd,
			sessionId: sid,
			sessionName: "",
			workspaceId: "",
			restored: true,
			pid: null,
			pidfile,
			terminalApp: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			briefing: "none",
			status: "starting",
			exited: false,
			exitCode: null
		};
		this.agents.set(agentId, handle);
		this.notify();
		try {
			const launched = await this.launcher.launch({ cwd: targetCwd, command: cmd, pidfile });
			handle.terminalApp = launched.app;
			const pid = await waitForPidfile(pidfile, 25000);
			handle.pid = pid;
			handle.status = pid !== null ? "working" : "unknown";
		} catch (error) {
			this.agents.delete(agentId);
			this.notify();
			throw error;
		}
		this.updated(handle);
		return handle;
	}

	// ------------------------------------------------------------ operations
	async read(id, bytes) {
		const handle = this.requireHandle(id);
		// 系统终端无法读实时输出：返回空 + 状态（会话历史见 /sessions）。
		return { output: "", truncated: false, exited: handle.exited, status: handle.status, exitCode: handle.exitCode ?? null, note: "系统终端模式不提供实时输出；见会话历史" };
	}

	async send(id, text, submit) {
		const handle = this.requireHandle(id);
		if (handle.exited) throw new Error(`agent ${id} 已退出`);
		if (handle.terminalApp) {
			try {
				await activateApp(handle.terminalApp === "terminal" ? "Terminal" : handle.terminalApp);
			} catch {}
		}
		if (submit === true) {
			await typeTextAndEnter(String(text ?? ""));
		} else {
			await typeText(String(text ?? ""));
		}
		handle.updatedAt = Date.now();
	}

	async approve(id, choice) {
		const handle = this.requireHandle(id);
		if (handle.terminalApp) {
			try {
				await activateApp(handle.terminalApp === "terminal" ? "Terminal" : handle.terminalApp);
			} catch {}
		}
		const c = choice === void 0 || choice === null ? "1" : String(choice);
		if (c === "") {
			await pressKey("return");
		} else {
			await typeTextAndEnter(c);
		}
		handle.updatedAt = Date.now();
	}

	async signal(id, signal) {
		const handle = this.requireHandle(id);
		if (!this.allowedSignals.includes(signal)) throw new Error(`signal ${signal} 不在白名单`);
		sendSignal(handle.pid, signal);
		handle.updatedAt = Date.now();
	}

	async close(id, graceful) {
		const handle = this.requireHandle(id);
		if (handle.pid !== null && isAlive(handle.pid)) {
			if (graceful !== false) {
				// 先发 SIGTERM，等 2s 没退再 SIGKILL
				sendSignal(handle.pid, "SIGTERM");
				await sleep(2000);
			}
			if (isAlive(handle.pid)) sendSignal(handle.pid, "SIGKILL");
		}
		handle.exited = true;
		handle.status = "exited";
		handle.exitCode = 0;
		this.agents.delete(id);
		this.notify();
	}

	async compactSession(id) {
		const handle = this.requireHandle(id);
		const cmd = ENGINE_COMMANDS[handle.type]?.compact;
		if (cmd) {
			try {
				if (handle.terminalApp) await activateApp(handle.terminalApp === "terminal" ? "Terminal" : handle.terminalApp);
				await typeTextAndEnter(cmd);
			} catch {}
		}
	}

	async newSession(id) {
		const handle = this.requireHandle(id);
		const cmd = ENGINE_COMMANDS[handle.type]?.clear;
		if (cmd) {
			try {
				if (handle.terminalApp) await activateApp(handle.terminalApp === "terminal" ? "Terminal" : handle.terminalApp);
				await typeTextAndEnter(cmd);
			} catch {}
		}
	}

	// ------------------------------------------------ legacy-compat stubs
	scanCwd() { return []; }
	restoreSaved() { return null; }
	forgetSaved() { return null; }
	restoreState() {}
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

	/** 2s 轮询进程存活：终端被关 → 进程消失 → 灰。 */
	async poll() {
		if (this._polling) return;
		this._polling = true;
		try {
			for (const handle of this.agents.values()) {
				if (handle.exited) continue;
				const alive = handle.pid !== null && isAlive(handle.pid);
				if (!alive && handle.status !== "exited") {
					handle.exited = true;
					handle.status = "exited";
					handle.updatedAt = Date.now();
					this.notify();
				}
			}
		} finally {
			this._polling = false;
		}
	}

	/** 角色/技能简报（与旧版同契约文案）。 */
	briefingText(handle) {
		const lines = [
			`[dsh-agent-commander] 你已被总指挥以「${handle.name}」的身份启动（引擎：${handle.type}，系统终端）。`,
			`职责定义：${handle.role}`,
			"团队协作协议（必须遵守）：",
			"1. 先读取工作目录 .deepseek/ 下的 memory.md、task-board.md、experience.md，了解团队上下文、进行中的任务、历史经验与 SQLite 记忆层用法。",
			"2. 完成任务后，在 .deepseek/task-board.md 和 SQLite 的 tasks 表中把对应任务状态更新为 ✅/❌ 并写明结果。",
			"3. 重要产出写入 .deepseek/handoffs/（文件名建议 .deepseek/handoffs/<你的名字>-<主题>.md），并在 handoffs 表登记。",
			"4. 工作结束后，在 .deepseek/experience.md 和 SQLite memory 表（namespace='experience'）中沉淀经验。",
			"5. 向总指挥（DeepSeek）汇报：做了什么、结果如何、下一步建议。"
		];
		for (const skill of handle.skills) lines.push(`请先阅读并遵循技能文件：${skill}`);
		return lines.join("\n");
	}

	/** 按键注入简报（claude/codex/codebuddy；需辅助功能权限）。 */
	injectBriefing(handle, briefing) {
		(async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (handle.exited) return;
				try {
					await sleep(3000 + attempt * 2000); // 等引擎 UI 就绪
					if (handle.terminalApp) {
						try {
							await activateApp(handle.terminalApp === "terminal" ? "Terminal" : handle.terminalApp);
						} catch {}
					}
					await typeTextAndEnter(briefing);
					handle.briefing = "done";
					this.updated(handle);
					return;
				} catch {}
			}
			handle.briefing = "pending";
			this.updated(handle);
		})();
	}

	shutdown() {
		clearInterval(this._pollTimer);
	}
}
