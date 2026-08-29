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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { TerminalLauncher, shq, waitForPidfile } from "./terminal-launcher.js";
import { isAlive, sendSignal } from "./process-monitor.js";
import { activateApp, typeTextAndEnter, pressKey } from "./keystroke.js";

export const ENGINE_TYPES = ["claude", "opencode", "codex", "codebuddy"];

const POLL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statOf(p) {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}

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

/** 解析引擎二进制：PATH + 常见目录 + nvm 版本目录（codebuddy 常装在 nvm node 下）。 */
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
	// nvm：~/.nvm/versions/node/<ver>/bin/<name>（实测 codebuddy 装在这里）
	try {
		const nvmRoot = join(process.env.HOME ?? "", ".nvm", "versions", "node");
		for (const version of readdirSync(nvmRoot)) {
			candidates.push(join(nvmRoot, version, "bin", name));
		}
	} catch {}
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
			if (pid !== null && handle.briefing === "pending" && type !== "opencode") {
				// 启动监控在后台执行（不阻塞创建返回，避免对话框卡死）：等 CLI 就绪
				// → 自动应答启动期确认弹窗 → 按键注入简报 → 会话文件验证落地；
				// 注入完成 briefing=done → WS 推送 → 客户端刷新会话历史。
				handle.status = "starting";
				this.updated(handle);
				this.monitorStartup(handle, briefing);
			} else {
				handle.status = pid !== null ? "working" : "unknown";
				this.updated(handle);
			}
		} catch (error) {
			this.agents.delete(agentId);
			this.notify();
			throw error;
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
	/** 运行中 handle 汇总（供 /sessions 标记 running）。key = `${engine}:${cwd}`。 */
	runningSessionKeys() {
		const out = new Map();
		for (const h of this.agents.values()) {
			if (h.exited) continue;
			const key = `${h.type}:${h.cwd}`;
			out.set(key, {
				agentId: h.id,
				name: h.name,
				type: h.type,
				cwd: h.cwd,
				pid: h.pid,
				sessionId: h.sessionId ?? "",
				status: h.status,
				createdAt: h.createdAt
			});
		}
		return out;
	}

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

	/** 按键注入简报（claude/codebuddy/codex；需辅助功能权限）。 */
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

	// ------------------------------------------------------------ 启动监控
	/**
	 * 新建流程的启动监控（终端宿主模式无 pty，用「会话文件」作为 CLI 输出代理）：
	 *   1. 等待 CLI 就绪 —— 引擎在自己的会话目录里写下首个会话文件（claude /
	 *      codebuddy 的 <sessionId>.jsonl，codex 的 rollout-*.jsonl）；
	 *   2. 期间自动应答启动确认弹窗 —— codebuddy 对未信任目录会弹文件夹信任询问
	 *      （默认项 = Yes），未信任时按节奏发回车「该点 yes 时点 yes」；
	 *   3. 就绪后按键注入角色/技能简报（activate + typeTextAndEnter）；
	 *   4. 在会话文件里验证简报落地（出现 "[dsh-agent-commander]" 用户消息）——
	 *      落地才置 briefing=done；否则回车一次（排掉可能的残留确认框）重试，
	 *      最多 3 次；总时长受限，超时降级 briefing=pending 但不失败。
	 */
	async monitorStartup(handle, briefing) {
		const marker = "[dsh-agent-commander]";
		const startedAt = Date.now();
		const CAP_MS = 75000; // 整个监控的硬上限
		// codebuddy 未信任该目录 → 启动时必弹文件夹信任确认 → 需要自动回车协助
		const needTrustAssist = handle.type === "codebuddy" && !this._codebuddyTrusted(handle.cwd);
		let trustPushes = 0;

		// ---- Phase 1: 等 CLI 就绪（会话文件出现），期间自动回车应答信任弹窗
		let sessionFile = null;
		while (Date.now() - startedAt < CAP_MS) {
			if (handle.exited) return;
			sessionFile = this._latestSessionFile(handle);
			if (sessionFile !== null) break;
			if (needTrustAssist && trustPushes < 6 && Date.now() - startedAt > 1500) {
				trustPushes++;
				try {
					await this._activate(handle);
					await pressKey("return");
				} catch {}
			}
			await sleep(800);
		}
		if (sessionFile === null) {
			// CLI 一直没写下会话文件（启动异常/卡死）——不阻塞创建，标记待注入
			handle.briefing = "pending";
			handle.status = "working";
			this.updated(handle);
			return;
		}

		// ---- Phase 2: 注入简报 + 验证落地（最多 3 次，总时长受 CAP_MS 约束）
		for (let attempt = 0; attempt < 3 && Date.now() - startedAt < CAP_MS; attempt++) {
			if (handle.exited) return;
			try {
				await this._activate(handle);
				await typeTextAndEnter(briefing);
			} catch {
				break; // 无辅助功能权限等：注入不可行，放弃（不阻塞创建）
			}
			const verifyDeadline = Math.min(Date.now() + 15000, startedAt + CAP_MS);
			while (Date.now() < verifyDeadline) {
				if (handle.exited) return;
				if (this._briefingLanded(handle, marker)) {
					handle.briefing = "done";
					handle.status = "working";
					this.updated(handle);
					return;
				}
				await sleep(800);
			}
			// 未落地：可能卡在残留确认框 → 回车一次再重试
			try {
				await this._activate(handle);
				await pressKey("return");
			} catch {}
		}
		handle.briefing = "pending";
		handle.status = "working";
		this.updated(handle);
	}

	/** 激活该 agent 所在的终端 App 到前台（按键注入前提）。 */
	async _activate(handle) {
		if (!handle.terminalApp) return;
		await activateApp(handle.terminalApp === "terminal" ? "Terminal" : handle.terminalApp);
	}

	/** codebuddy 是否已信任该目录（trustedDirectories 含 cwd → 无信任弹窗）。 */
	_codebuddyTrusted(cwd) {
		try {
			const settings = JSON.parse(readFileSync(join(homedir(), ".codebuddy", "settings.json"), "utf8"));
			const list = Array.isArray(settings?.trustedDirectories) ? settings.trustedDirectories : [];
			return list.includes(cwd);
		} catch {
			return false;
		}
	}

	/** 引擎的会话目录（claude/codebuddy 的 projects/<slug>；codex 的 sessions 树）。 */
	_sessionDir(handle) {
		if (handle.type === "claude") {
			return join(homedir(), ".claude", "projects", String(handle.cwd ?? "").replace(/[^a-zA-Z0-9]+/g, "-"));
		}
		if (handle.type === "codebuddy") {
			// codebuddy slug 与 claude 不同：去前导 '/',保留下划线（见 session-scanner.codebuddySlugOf）
			return join(homedir(), ".codebuddy", "projects", String(handle.cwd ?? "").replace(/^\/+/, "").replace(/[^a-zA-Z0-9_]+/g, "-"));
		}
		if (handle.type === "codex") {
			return join(homedir(), ".codex", "sessions");
		}
		return null;
	}

	/**
	 * 找「本次启动」对应的最新会话文件（mtime >= handle.createdAt - 5s 容差）。
	 * claude/codebuddy：projects/<slug>/ 下的 .jsonl；codex：sessions 树里
	 * session_meta.cwd 匹配的 rollout-*.jsonl。找不到返回 null。
	 */
	_latestSessionFile(handle) {
		const dir = this._sessionDir(handle);
		if (dir === null) return null;
		const bornAfter = (handle.createdAt ?? 0) - 5000;
		try {
			if (handle.type === "claude" || handle.type === "codebuddy") {
				let best = null;
				for (const f of readdirSync(dir)) {
					if (!f.endsWith(".jsonl")) continue;
					const full = join(dir, f);
					let st;
					try {
						st = statOf(full);
					} catch {
						continue;
					}
					if (st === null || st.mtimeMs < bornAfter) continue;
					if (best === null || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
				}
				return best;
			}
			if (handle.type === "codex") {
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
								if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
							} catch {}
						}
					}
				};
				walk(dir);
				return best;
			}
		} catch {}
		return null;
	}

	/** 简报是否已落地：最新会话文件里出现含 marker 的用户消息（JSON 原文即可）。 */
	_briefingLanded(handle, marker) {
		const found = this._latestSessionFile(handle);
		if (found === null) return false;
		try {
			const tail = readFileSync(found.path, "utf8").slice(-131072);
			return tail.includes(marker);
		} catch {
			return false;
		}
	}

	shutdown() {
		clearInterval(this._pollTimer);
	}
}
