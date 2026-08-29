// ============================================================================
// composite-registry.js — 按宿主可用性的组合注册表。
//
// herdr 优先：claude / opencode / codex 走 herdr kind；codebuddy 没有 herdr
// kind（herdr 0.8.2 kind 列表二进制硬编码，manifest 只能定义检测规则、不能
// 注册新 kind），由 herdr 注册表用「裸 pane」模式承接——herdr 建 pane 后直接
// 在 pane 里输入 codebuddy 命令，用 paneRead/paneSendText 监控与操作
// （见 herdr-registry 的 RAW_PANE_ENGINES）。仅当 herdr 不可用
// （agentHost=terminal-host 或未找到 herdr 二进制）时，全部引擎回退到
// 系统终端宿主 TerminalAgentRegistry。
// 对 tools / HTTP API / WebSocket 暴露与单一注册表完全相同的表面，按 handle
// 归属路由操作。
// ============================================================================

import { ENGINE_TYPES } from "./terminal-registry.js";

export class CompositeRegistry {
	/**
	 * @param {object} opts
	 * @param {object|null} opts.herdr    HerdrAgentRegistry（herdr 可用时）
	 * @param {object|null} opts.terminal TerminalAgentRegistry（总是创建）
	 * @param {object} opts.herdrKinds    引擎 → herdr kind 映射（HERDR_KIND_MAP）
	 */
	constructor({ herdr = null, terminal = null, herdrKinds = {} }) {
		this.herdr = herdr;
		this.terminal = terminal;
		this.herdrKinds = herdrKinds;
		this.primary = herdr ?? terminal;
		if (this.primary === null) throw new Error("CompositeRegistry: no underlying registry");
	}

	/** 引擎路由到哪个宿主：herdr 在场一律 herdr（codebuddy 走裸 pane）。 */
	_hostForType(_type) {
		if (this.herdr !== null) return this.herdr;
		return this.terminal;
	}

	/** 某个 agent id 归哪个宿主（按 handle 归属，跨引擎稳定路由）。 */
	_owner(id) {
		if (this.herdr !== null && this.herdr.get(id) !== void 0) return this.herdr;
		if (this.terminal !== null && this.terminal.get(id) !== void 0) return this.terminal;
		return null;
	}

	// ------------------------------------------------------------ meta passthrough
	get maxAgents() {
		return this.primary.maxAgents;
	}
	get transcriptLimit() {
		return this.primary.transcriptLimit;
	}
	get allowedSignals() {
		return this.primary.allowedSignals;
	}
	get baseCwd() {
		return this.primary.baseCwd;
	}
	get memoryDir() {
		return this.primary.memoryDir;
	}
	get launcher() {
		return this.primary.launcher;
	}
	/** 引擎可用性（/terminal/status 用）：herdr 在场用 herdr 的（含 codebuddy
	 *  裸 pane 二进制）；否则用系统终端的。 */
	get binaries() {
		const out = {};
		const src = this.herdr !== null ? this.herdr : this.terminal;
		for (const engine of ENGINE_TYPES) {
			out[engine] = src?.binaries?.[engine] ?? null;
		}
		return out;
	}
	/** 组合 agents Map（/cache/compress 用 [...registry.agents.values()]）。 */
	get agents() {
		const m = new Map();
		if (this.herdr !== null) for (const [k, v] of this.herdr.agents) m.set(k, v);
		if (this.terminal !== null) for (const [k, v] of this.terminal.agents) m.set(k, v);
		return m;
	}

	// ------------------------------------------------------------ sync reads
	list() {
		return [...(this.herdr?.list() ?? []), ...(this.terminal?.list() ?? [])];
	}
	listByCwd(cwd) {
		return [...(this.herdr?.listByCwd(cwd) ?? []), ...(this.terminal?.listByCwd(cwd) ?? [])];
	}
	get(id) {
		const owner = this._owner(id);
		return owner === null ? void 0 : owner.get(id);
	}
	meta(handle) {
		if (handle === void 0 || handle === null) return null;
		if (this.herdr !== null && this.herdr.get(handle.id) !== void 0) return this.herdr.meta(handle);
		if (this.terminal !== null) return this.terminal.meta(handle);
		return null;
	}
	subscribe(fn) {
		const unsubs = [];
		if (this.herdr !== null) unsubs.push(this.herdr.subscribe(fn));
		if (this.terminal !== null) unsubs.push(this.terminal.subscribe(fn));
		return () => {
			for (const unsub of unsubs) {
				try {
					unsub();
				} catch {}
			}
		};
	}

	// ------------------------------------------------------------ creation / restore
	async create(opts) {
		return this._hostForType(String(opts?.type ?? "")).create(opts);
	}
	async restoreSession(opts) {
		return this._hostForType(String(opts?.engine ?? "")).restoreSession(opts);
	}

	// ------------------------------------------------------------ operations (按 handle 归属路由)
	async send(id, text, submit) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.send(id, text, submit);
	}
	async read(id, bytes) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.read(id, bytes);
	}
	async approve(id, choice) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.approve(id, choice);
	}
	async signal(id, signal) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.signal(id, signal);
	}
	async close(id, graceful) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.close(id, graceful);
	}
	async compactSession(id) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.compactSession(id);
	}
	async newSession(id) {
		const owner = this._owner(id);
		if (owner === null) throw new Error(`agent ${id} 不存在（可能已关闭）`);
		return owner.newSession(id);
	}

	/** 运行中窗口汇总（/sessions 标记 running）：两个宿主的 key 合并。 */
	runningSessionKeys() {
		const out = new Map();
		if (this.herdr !== null) for (const [k, v] of this.herdr.runningSessionKeys()) out.set(k, v);
		if (this.terminal !== null) for (const [k, v] of this.terminal.runningSessionKeys()) out.set(k, v);
		return out;
	}

	// -------------------------------------------------- legacy-only stubs（透传，均为空实现）
	scanCwd(cwd) {
		return [...(this.herdr?.scanCwd?.(cwd) ?? []), ...(this.terminal?.scanCwd?.(cwd) ?? [])];
	}
	restoreSaved() {
		return null;
	}
	forgetSaved() {
		return null;
	}
	restoreState() {}
	allCacheInfo() {
		return [...(this.herdr?.allCacheInfo?.() ?? []), ...(this.terminal?.allCacheInfo?.() ?? [])];
	}
	compressCache() {
		return [];
	}

	shutdown() {
		try {
			this.herdr?.shutdown?.();
		} catch {}
		try {
			this.terminal?.shutdown?.();
		} catch {}
	}
}
