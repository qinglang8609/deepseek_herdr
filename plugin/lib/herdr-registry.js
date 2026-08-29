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
import { basename } from "node:path";
import { HerdrAdapter, HerdrError, HERDR_ERRORS } from "./herdr-adapter.js";

/** DSH engine type → herdr `agent start --kind`. codebuddy 无 herdr kind。 */
export const HERDR_KIND_MAP = {
	claude: "claude",
	opencode: "opencode",
	codex: "codex",
	qwen: "qwen",
	pi: "pi"
};

const POLL_MS = 2000;
// 退出判定宽限：agent 需先被 herdr 列表见过，且消失超过该时长才标 exited
// （覆盖 agentStart 启动期 30-60s 内尚未进入列表的窗口）。
const EXIT_GRACE_MS = 30000;
// 外部（非本插件创建）智能体退出后，缓存保留多久再清理，防幽灵记录累积。
const EXTERNAL_PRUNE_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
		this._pollTimer = setInterval(() => { this.refresh().catch(() => {}); }, POLL_MS);
		this.refresh().catch(() => {});
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
			sessionName: handle.sessionName,
			workspaceId: handle.workspaceId,
			restored: handle.restored === true,
			briefing: handle.briefing ?? "none",
			external: handle.external === true,
			createdAt: handle.createdAt,
			updatedAt: handle.updatedAt
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
	async create({ type, name, role, skills, cwd, cols, rows, id }) {
		if (this.agents.size >= this.maxAgents) throw new Error(`agent limit reached (${this.maxAgents})`);
		const kind = HERDR_KIND_MAP[type];
		if (kind === void 0) {
			throw new Error(`agent type "${type}" 不支持 herdr 模式（支持：${Object.keys(HERDR_KIND_MAP).join(" / ")}）`);
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
			sessionId: "",
			sessionName: "",
			restored: false,
			pid: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			briefing: trimmedRole !== "" || skillList.length > 0 ? "pending" : "none",
			status: "unknown",
			exited: false,
			exitCode: null,
			_wsCreated: wsCreated === true
		};
		this.agents.set(agentId, handle);
		this.notify();
		try {
			const started = await this.adapter.agentStart(herdrName, kind, paneId, { timeoutMs: 60000 });
			handle.status = mapStatus(started?.agent?.agent_status);
		} catch (error) {
			if (error instanceof HerdrError && error.code === HERDR_ERRORS.AGENT_NOT_READY) {
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
				throw error;
			}
		}
		this.updated(handle);
		// 简报注入异步执行（不阻塞 agent_open 返回）。
		if (handle.briefing === "pending") {
			const briefing = this.briefingText(handle);
			this.injectBriefing(handle, briefing);
		}
		return handle;
	}

	// ------------------------------------------------------------ operations
	async read(id, bytes) {
		const handle = this.requireHandle(id);
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
		if (handle.exited) throw new Error(`agent ${id} 已退出`);
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
		await this.adapter.agentSendKeys(handle.herdrName, key);
		handle.updatedAt = Date.now();
	}

	async close(id, graceful) {
		const handle = this.requireHandle(id);
		const { paneId, cwd, _wsCreated } = handle;
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
		this.notify();
	}

	async compactSession(id) {
		const handle = this.requireHandle(id);
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
						sessionId: "",
						sessionName: "",
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
						_seenAt: Date.now()
					};
					this.agents.set(handle.id, handle);
					this.notify();
				}
				seen.add(handle.id);
				if (handle._seenAt === void 0) handle._seenAt = Date.now();
				const status = mapStatus(e.agent_status ?? e.status);
				if (handle.status !== status) {
					handle.status = status;
					handle.updatedAt = Date.now();
					this.notify();
				}
				if (typeof e.cwd === "string" && e.cwd !== "" && handle.cwd !== e.cwd) handle.cwd = e.cwd;
				if (typeof e.pane_id === "string" && e.pane_id !== "") handle.paneId = e.pane_id;
				if (typeof e.workspace_id === "string" && e.workspace_id !== "") handle.workspaceId = e.workspace_id;
			}
			const now = Date.now();
			for (const [id, handle] of this.agents) {
				if (seen.has(id)) continue;
				// 退出判定要求先见过一次（避免启动期/恢复期误标 exited）。
				if (handle._seenAt === void 0 || now - handle._seenAt < EXIT_GRACE_MS) continue;
				if (!handle.exited) {
					handle.exited = true;
					handle.status = "exited";
					handle.updatedAt = now;
					this.notify();
				}
				// 外部智能体退出一段时间后从缓存移除（防幽灵累积）。
				if (handle.external === true && now - handle.updatedAt > EXTERNAL_PRUNE_MS) {
					this.agents.delete(id);
					this.notify();
				}
			}
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

	shutdown() {
		clearInterval(this._pollTimer);
	}
}

export { HerdrAdapter, HerdrError, HERDR_ERRORS };
