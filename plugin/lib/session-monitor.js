// ============================================================================
// session-monitor.js — 会话状态定时巡检（服务端）。
//
// 会话状态 = 历史会话（四引擎扫描）与运行中的智能体窗口合并后的结果：
//   running  —— 有存活窗口承接该会话（引擎进程在跑）
//   starting —— 窗口刚拉起，引擎尚未就绪
//   exited   —— 窗口登记为已退出（巡检周期内的收尾态）
//   idle     —— 历史会话，当前没有窗口承接
//
// 巡检按 Config.monitorIntervalMs 对每个「被订阅」的工作目录重建会话列表，
// 只有状态签名变化时才推送 —— 无变化的周期不产生空推，客户端因此可以做纯
// 静默刷新（不打扰用户，只在真的变了才换列表）。
//
// buildSessionList 同时被 /sessions 路由复用：一次实现，两处消费，避免
// 「API 返回的列表」与「巡检推送的列表」漂移。
// ============================================================================

/** 默认巡检间隔（毫秒）。0 表示关闭定时巡检。 */
export const MONITOR_INTERVAL_MS = 30000;

/** 会话状态：优先用运行窗口的 agent 状态，无窗口即空闲。 */
export function statusOfSession(sess) {
	if (sess?.running !== true) return "idle";
	const st = sess.runningAgent?.status;
	if (st === "starting") return "starting";
	if (st === "exited") return "exited";
	return "running";
}

/** 状态签名：引擎 + 会话 ID + 状态 + 时间 + token 全部相同才算无变化。 */
function signatureOf(list) {
	return list.map((s) => `${s.engine}:${s.id}:${s.status}:${s.time ?? 0}:${s.tokens ?? 0}`).join("|");
}

/**
 * 构建某工作目录的会话列表（历史会话 ∪ 运行中窗口），并标注状态。
 * @param {object} registry 组合注册表（提供 syncPaneAgents / runningSessions）
 * @param {object} scanner  SessionScanner
 * @param {string} cwd      工作目录（空串 = 不扫描，返回空列表）
 * @returns {Promise<object[]>} 会话列表（按时间倒序，最新的在最前）
 */
export async function buildSessionList(registry, scanner, cwd) {
	// 未绑定工作区 → 空列表：会话与窗口都按工作目录归属，没有目录无从归属。
	if (cwd === "") return [];
	// 接管宿主认不出的运行中窗口（系统终端/裸 pane 引擎；node-pty 下为空操作）。
	await registry.syncPaneAgents?.(cwd);
	const sessions = await scanner.list(cwd);
	const running = registry.runningSessions();
	const engineSessions = new Map(); // engine → 该 cwd 的历史会话（按时间倒序）
	for (const s of sessions) {
		if (s.cwd !== cwd) continue;
		if (!engineSessions.has(s.engine)) engineSessions.set(s.engine, []);
		engineSessions.get(s.engine).push(s);
	}
	for (const s of sessions) s.running = false;
	// 只做「标注」：运行中的窗口若是某条历史会话，只给它打 running 标记（不追加
	// 假的历史条目）。运行中列表由 /agents 独立提供（node-pty 下是活跃进程），
	// 会话历史列表保持纯历史 —— 两个列表独立展示、可重叠但不混淆。
	// 只做「精确命中」：窗口的会话缓存 ID == 历史会话 id。绝不猜"该引擎最新会话"
	// 去关联 —— 那样会把没在运行的会话误标成运行中（用户反馈的错标 bug）。
	// （会话缓存 ID 由注册表按「窗口创建之后新落盘的会话文件」发现补齐 —— 只认
	// 窗口自己的会话，依旧不会错标旧会话。）
	const boundAgents = new Set(); // 已精确命中历史会话的运行窗口 agentId
	for (const r of running) {
		if (r.cwd !== cwd) continue;
		const engine = r.type;
		const list = engineSessions.get(engine) ?? [];
		let hit = r.sessionId !== "" ? list.find((s) => s.id === r.sessionId) : void 0;
		if (hit !== void 0) {
			hit.running = true;
			hit.runningAgent = r; // { agentId, name, pid, sessionId, status, createdAt, paneId }
			boundAgents.add(r.agentId);
		}
	}
	// 没有命中任何历史会话的运行窗口（刚创建、引擎还没写会话文件）：合成一张
	// live 卡片，让「当前会话」立刻可见 —— 否则新建智能体后在会话历史里完全隐身，
	// 用户不知道窗口开没开成功（用户反馈 bug）。引擎写下首条消息后，真实会话卡片
	// 出现并精确命中，live 卡片随之消失（同一窗口只显示一张卡）。
	for (const r of running) {
		if (r.cwd !== cwd || boundAgents.has(r.agentId)) continue;
		sessions.push({
			engine: r.type,
			id: `live:${r.agentId}`,
			title: r.name || r.type,
			time: r.updatedAt ?? r.createdAt ?? Date.now(),
			tokens: 0,
			cost: null,
			cwd,
			running: true,
			runningAgent: r,
			live: true
		});
	}
	for (const s of sessions) s.status = statusOfSession(s);
	return sessions.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

/** 会话定时巡检：按间隔重建被订阅工作目录的会话列表，状态变化才推送。 */
export class SessionMonitor {
	/**
	 * @param {object} opts
	 * @param {object} opts.registry   组合注册表
	 * @param {object} opts.scanner    SessionScanner
	 * @param {number} opts.intervalMs 巡检间隔（0 = 关闭定时巡检，仍可 watch 拿首帧）
	 * @param {object} [opts.logger]   cordis logger（warn 用）
	 */
	constructor({ registry, scanner, intervalMs = MONITOR_INTERVAL_MS, logger = null } = {}) {
		this.registry = registry;
		this.scanner = scanner;
		this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.trunc(intervalMs) : 0;
		this.logger = logger;
		this.watchers = new Map(); // cwd → Set<fn>
		this.signatures = new Map(); // cwd → 上次推送的状态签名
		this._ticking = false;
		this._timer = null;
		if (this.intervalMs > 0) {
			this._timer = setInterval(() => {
				this.tick().catch(() => {});
			}, this.intervalMs);
		}
	}

	/** 定时巡检是否启用（intervalMs > 0）。 */
	get enabled() {
		return this.intervalMs > 0;
	}

	/**
	 * 订阅一个工作目录的会话状态。订阅瞬间先推送一次当前列表，
	 * 之后仅在状态签名变化时推送。
	 * @returns {() => void} 取消订阅
	 */
	watch(cwd, fn) {
		const key = typeof cwd === "string" ? cwd : "";
		let set = this.watchers.get(key);
		if (set === void 0) {
			set = new Set();
			this.watchers.set(key, set);
		}
		set.add(fn);
		this.refresh(key).catch(() => {});
		return () => {
			const current = this.watchers.get(key);
			if (current === void 0) return;
			current.delete(fn);
			if (current.size > 0) return;
			// 最后一个订阅者离开：同时丢弃签名，下次订阅重新推送首帧，
			// 也避免长时间无人看时积累陈旧基线。
			this.watchers.delete(key);
			this.signatures.delete(key);
		};
	}

	/** 重建一个工作目录的列表并（仅当签名变化时）推送。 */
	async refresh(cwd) {
		const sessions = await buildSessionList(this.registry, this.scanner, cwd);
		const signature = signatureOf(sessions);
		if (this.signatures.get(cwd) === signature) return;
		this.signatures.set(cwd, signature);
		this.emit(cwd, sessions);
	}

	/** 一轮全量巡检：遍历所有被订阅的工作目录。 */
	async tick() {
		if (this._ticking || this.watchers.size === 0) return;
		this._ticking = true;
		try {
			for (const cwd of [...this.watchers.keys()]) {
				try {
					await this.refresh(cwd);
				} catch (error) {
					this.logger?.warn?.(`[dsh-agent-commander] 会话巡检失败（${cwd}）：${error?.message ?? error}`);
				}
			}
		} finally {
			this._ticking = false;
		}
	}

	emit(cwd, sessions) {
		const set = this.watchers.get(cwd);
		if (set === void 0) return;
		const payload = { cwd, at: Date.now(), sessions };
		for (const fn of [...set]) {
			try {
				fn(payload);
			} catch {}
		}
	}

	/** 停表并清空订阅（插件卸载时调用）。 */
	stop() {
		if (this._timer !== null) {
			clearInterval(this._timer);
			this._timer = null;
		}
		this.watchers.clear();
		this.signatures.clear();
	}
}
