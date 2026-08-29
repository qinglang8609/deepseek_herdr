// ============================================================================
// dsh-agent-commander — client application (plain JS + React createElement)
//
// Registers the "Agent Radar" panel into the app's real right "details"
// column (no floating overlay). Terminal-host mode: agents are real processes
// running in system terminal windows (Terminal.app / Ghostty / iTerm2) — the
// radar does NOT render a browser terminal. It only does two things:
//   • 运行中  = currently open agents (process alive green/gray, no live output)
//   • 会话历史 = cc-switch style history for the four engines of this
//     workspace (time / ID / title / tokens + 恢复 / 删除 buttons)
// Click an agent card to open its detail: actions (中断/压缩/清空/关闭) + a
// keystroke send box (needs macOS Accessibility permission).
//
// Details-column caveat: AppFrame only gives the details track a width when
// the current session is non-blank. A width-enforcement effect takes over the
// last grid track ONLY when the app left it at 0 (blank/fresh session), so the
// panel is a real column in every state; when the app itself opens the column
// (non-blank session, drag resize) its value is respected.
// ============================================================================
const { useEffect, useState, useRef, useCallback } = react;
const h = react.createElement;

// ---------------------------------------------------------------------------
// Standard icon set — inline Lucide-style SVGs (stroke-based, currentColor).
// Self-contained so the single-file client bundle needs no icon dependency.
// Each entry: name → array of [tagName, attrs] describing the 24×24 glyph.
// ---------------------------------------------------------------------------
const ICON_PATHS = {
	"x": [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
	"power": [["path", { d: "M12 2v10" }], ["path", { d: "M18.4 6.6a9 9 0 1 1-12.77.04" }]],
	"rotate-ccw": [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }]],
	"refresh-cw": [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
	"minimize": [["path", { d: "m14 10 7-7" }], ["path", { d: "M20 10h-6V4" }], ["path", { d: "m3 21 7-7" }], ["path", { d: "M4 14h6v6" }]],
	"folder": [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
	"clock": [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 6v6l4 2" }]],
	"alert": [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
	"chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
	"plus": [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
	"stop": [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2, fill: "currentColor", stroke: "none" }]],
	"bot": [["path", { d: "M12 8V4H8" }], ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }], ["path", { d: "M2 14h2" }], ["path", { d: "M20 14h2" }], ["path", { d: "M15 13v2" }], ["path", { d: "M9 13v2" }]],
	"layout": [["rect", { width: 7, height: 7, x: 3, y: 3, rx: 1 }], ["rect", { width: 7, height: 7, x: 14, y: 3, rx: 1 }], ["rect", { width: 7, height: 7, x: 14, y: 14, rx: 1 }], ["rect", { width: 7, height: 7, x: 3, y: 14, rx: 1 }]],
	"stopwatch": [["circle", { cx: 12, cy: 13, r: 8 }], ["path", { d: "M12 9v4l2 2" }], ["path", { d: "M9 2h6" }], ["path", { d: "M12 2v3" }]]
};

function Icon({ name, size = 14, className = "" }) {
	const parts = ICON_PATHS[name] || [];
	if (parts.length === 0) return null;
	return h("svg", {
		className: `dhac_icon${className ? " " + className : ""}`,
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true"
	}, parts.map(([tag, attrs], i) => h(tag, { key: i, ...attrs })));
}

// HTML string variant for imperatively-built DOM (toggle button).
function iconSvgMarkup(name, size = 15) {
	const parts = ICON_PATHS[name] || [];
	const inner = parts.map(([tag, attrs]) => {
		const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ");
		return `<${tag} ${attrStr}></${tag}>`;
	}).join("");
	return `<svg class="dhac_icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
const API_BASE = "/agent-commander/api";
async function apiGet(path) {
	const res = await fetch(API_BASE + path, { headers: { accept: "application/json" } });
	const body = await res.json().catch(() => null);
	if (!res.ok || body?.ok !== true) throw new Error(body?.error?.message || `HTTP ${res.status}`);
	return body.value;
}
async function apiPost(path, payload) {
	const res = await fetch(API_BASE + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload ?? {})
	});
	const body = await res.json().catch(() => null);
	if (!res.ok || body?.ok !== true) throw new Error(body?.error?.message || `HTTP ${res.status}`);
	return body.value;
}
async function apiDelete(path) {
	const res = await fetch(API_BASE + path, { method: "DELETE" });
	const body = await res.json().catch(() => null);
	if (!res.ok || body?.ok !== true) throw new Error(body?.error?.message || `HTTP ${res.status}`);
	return body.value;
}
function wsUrl(path) {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}${path}`;
}

// ---------------------------------------------------------------------------
// Agent snapshot store (module level — shared across mounts)
// ---------------------------------------------------------------------------
const agentListeners = new Set();
let agentSnapshot = [];
let listWs = null;
let listCwd = void 0;
function setAgents(next) {
	agentSnapshot = Array.isArray(next) ? next : [];
	for (const fn of [...agentListeners]) fn(agentSnapshot);
}
function getAgents() {
	return agentSnapshot;
}
let subscriberCount = 0;
function subscribeAgents(fn) {
	subscriberCount++;
	agentListeners.add(fn);
	fn(agentSnapshot);
	return () => {
		agentListeners.delete(fn);
		subscriberCount--;
		if (subscriberCount === 0 && listWs !== null) {
			try { listWs.close(); } catch {}
			listWs = null;
		}
	};
}
/** Scope the pushed agent list to a workspace folder and reconnect the WS.
 * Called whenever the current session's working directory changes, so the
 * radar only ever shows (and live-updates) THIS folder's agents. */
function setListCwd(cwd) {
	const next = typeof cwd === "string" && cwd !== "" ? cwd : void 0;
	if (next === listCwd) return;
	listCwd = next;
	if (listWs !== null) {
		try {
			listWs.close();
		} catch {}
		listWs = null;
	}
	connectListWs();
}
let connecting = false;
function connectListWs() {
	if (connecting) return;
	if (listWs !== null && (listWs.readyState === WebSocket.CONNECTING || listWs.readyState === WebSocket.OPEN)) return;
	connecting = true;
	let ws;
	const open = () => {
		if (listWs !== null && (listWs.readyState === WebSocket.CONNECTING || listWs.readyState === WebSocket.OPEN)) {
			connecting = false;
			return;
		}
		const qs = listCwd !== void 0 ? `?cwd=${encodeURIComponent(listCwd)}` : "";
		ws = new WebSocket(wsUrl(`/agent-commander/ws/list${qs}`));
		listWs = ws;
		ws.onmessage = (e) => {
			try {
				setAgents(JSON.parse(e.data));
			} catch {}
		};
		ws.onclose = () => {
			if (listWs === ws) listWs = null;
			connecting = false;
			setTimeout(open, 2000);
		};
		ws.onerror = () => {
			try {
				ws.close();
			} catch {}
		};
	};
	open();
}

// ---------------------------------------------------------------------------
// Status labels (terminal-host mode: process alive green / exited gray)
// ---------------------------------------------------------------------------
const STATUS_LABEL = {
	working: "工作中",
	starting: "启动中",
	exited: "已退出",
	unknown: "未知"
};

// ---------------------------------------------------------------------------
// Details-column width enforcement.
//
// The AppFrame grid track for the details column stays 0 while the current
// session is blank. We watch the frame and take over the LAST track only when
// the app itself left it at 0 — this keeps the radar a REAL sidebar column on
// blank sessions without fighting drag-resize / natural widths otherwise.
// ---------------------------------------------------------------------------
const PANEL_WIDTH_KEY = "dsh-agent-commander.panelWidth";
const PANEL_WIDTH_DEFAULT = 380;
const PANEL_COLLAPSED_KEY = "dsh-agent-commander.panelCollapsed";
function isPanelCollapsed() {
	try { return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1"; }
	catch { return false; }
}
function setPanelCollapsed(collapsed) {
	try {
		if (collapsed) localStorage.setItem(PANEL_COLLAPSED_KEY, "1");
		else localStorage.removeItem(PANEL_COLLAPSED_KEY);
	} catch {}
}

function useDetailsColumn() {
	const rootRef = useRef(null);
	const [width, setWidth] = useState(() => {
		try {
			const w = Number(localStorage.getItem(PANEL_WIDTH_KEY));
			return Number.isFinite(w) && w >= 280 && w <= 620 ? w : PANEL_WIDTH_DEFAULT;
		} catch {
			return PANEL_WIDTH_DEFAULT;
		}
	});
	const stateRef = useRef({ width });
	stateRef.current = { width };

	useEffect(() => {
		try {
			const root = rootRef.current;
			if (root === null) return;
			const column = root.parentElement;
			const frame = column?.parentElement;
			if (frame === null || frame === void 0) return;
			let raf = 0;
			const enforce = () => {
				raf = 0;
				try {
					if (isPanelCollapsed()) return;
					const w = stateRef.current.width;
					const style = frame.style.gridTemplateColumns;
					if (typeof style !== "string" || style === "") return;
					const last = style.match(/(\S+)\s*$/)?.[1];
					if (last === "0px" || last === "0") {
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${w}px`);
						frame.removeAttribute("data-details-collapsed");
					}
				} catch {}
			};
			const schedule = () => {
				if (raf === 0) raf = requestAnimationFrame(enforce);
			};
			schedule();
			return () => {
				if (raf !== 0) cancelAnimationFrame(raf);
			};
		} catch {}
	}, [width]);

	useEffect(() => {
		try {
			localStorage.setItem(PANEL_WIDTH_KEY, String(width));
		} catch {}
	}, [width]);

	const onDragStart = useCallback((e) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		const onMove = (ev) => {
			const w = Math.min(620, Math.max(280, startW + (startX - ev.clientX)));
			setWidth(w);
			try {
				const column = rootRef.current?.parentElement;
				const frame = column?.parentElement;
				if (frame) {
					const style = frame.style.gridTemplateColumns;
					if (typeof style === "string" && style !== "") frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${w}px`);
				}
			} catch {}
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [width, rootRef]);

	return { rootRef, onDragStart };
}

// ---------------------------------------------------------------------------
// Engine / dialog constants
// ---------------------------------------------------------------------------
const ENGINE_TYPES = ["claude", "opencode", "codex", "codebuddy"];
const COMPACT_SUPPORTED = new Set(["claude", "codebuddy"]);
const DEFAULT_ROLE_PRESETS = ["数据库专家", "设计专家", "前端专家", "测试专家", "代码审查专家", "架构师"];

// 引擎 chip 色：claude 橙 / opencode 绿 / codex 蓝 / codebuddy 紫。
const ENGINE_META = {
	claude: { label: "claude" },
	opencode: { label: "opencode" },
	codex: { label: "codex" },
	codebuddy: { label: "codebuddy" }
};

// ---------------------------------------------------------------------------
// Runtime config (mirror of the server-side Config schema, fetched lazily).
// The 新建智能体 dialog uses server-configured rolePresets when available,
// falling back to the built-in presets — so a user can add presets from
// cordis.yml without touching client code (plugin standard: no hardcoded
// tunables).
// ---------------------------------------------------------------------------
let pluginConfig = null;
let pluginConfigPromise = null;
function getPluginConfig() {
	if (pluginConfigPromise === null) {
		pluginConfigPromise = apiGet("/config").then((value) => {
			pluginConfig = value?.config ?? null;
			return pluginConfig;
		}).catch(() => {
			pluginConfig = null;
			return null;
		});
	}
	return pluginConfigPromise;
}
function getRolePresets() {
	return (pluginConfig !== null && Array.isArray(pluginConfig.rolePresets) && pluginConfig.rolePresets.length > 0)
		? pluginConfig.rolePresets
		: DEFAULT_ROLE_PRESETS;
}

// ---------------------------------------------------------------------------
// 卡片时间/统计工具
// ---------------------------------------------------------------------------
function fmtTime(ts) {
	if (!Number.isFinite(ts)) return "-";
	const d = new Date(ts);
	const now = new Date();
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
function fmtUptime(ts) {
	if (!Number.isFinite(ts)) return "-";
	let s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return `${s}秒`;
	const m = Math.floor(s / 60);
	s %= 60;
	if (m < 60) return `${m}分${s}秒`;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	if (h < 24) return `${h}小时${String(mm).padStart(2, "0")}分`;
	return `${Math.floor(h / 24)}天${h % 24}小时`;
}
function fmtTokens(n) {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(n);
	if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1e6).toFixed(2)}M`;
}
/** 会话历史相对时间：「刚刚 / 12分钟前 / 3小时前 / 昨天 15:30 / 8-12 09:00」。 */
function fmtRelative(ts) {
	if (!Number.isFinite(ts)) return "-";
	const diff = Date.now() - ts;
	const sec = Math.max(0, Math.floor(diff / 1000));
	if (sec < 60) return "刚刚";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}小时前`;
	const d = new Date(ts);
	const now = new Date();
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
	if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// New-agent dialog（终端宿主模式）
// 引擎下拉来自 /terminal/status 的 engines（未安装 disabled）；角色 presets、
// 技能勾选逻辑与旧版一致。
// ---------------------------------------------------------------------------
function NewAgentDialog({ terminalStatus, sessionId, sessionName, defaultCwd, onClose, onCreated }) {
	const [type, setType] = useState("opencode");
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [cwd, setCwd] = useState(defaultCwd ?? "");
	const [rolePresets, setRolePresets] = useState(DEFAULT_ROLE_PRESETS);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		getPluginConfig().then(() => {
			setRolePresets(getRolePresets());
		});
	}, []);

	const engines = Array.isArray(terminalStatus?.engines) && terminalStatus.engines.length > 0
		? terminalStatus.engines
		: ENGINE_TYPES.map((id) => ({ id, installed: true }));
	const terminalLabel = terminalStatus?.label ?? "终端";

	const submit = async () => {
		if (busy) return;
		if (type === "") {
			setError(`请选择智能体引擎（${ENGINE_TYPES.join(" / ")}）`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const body = await apiPost("/agents", { sessionId, sessionName, type, name, role, cwd });
			onCreated(body.agent);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return h("div", { className: "dhac_modal", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } }, [
		h("div", { className: "dhac_dialog" }, [
			h("div", { className: "dhac_dialogTitle" }, "新建智能体"),
			h("div", { className: "dhac_dialogBody" }, [
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "引擎类型"),
					h("select", { className: "dhac_select", value: type, onChange: (e) => setType(e.target.value) },
						engines.map((t) => {
							const available = t.installed === true;
							return h("option", { key: t.id, value: t.id, disabled: !available }, available ? t.id : `${t.id}（未安装）`);
						}))
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "智能体名称"),
					h("input", { className: "dhac_input", value: name, placeholder: `默认：${type}`, onChange: (e) => setName(e.target.value) })
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "角色定义（注入给该智能体的开场简报）"),
					h("div", { className: "dhac_presets" },
						rolePresets.map((preset) =>
							h("button", { key: preset, type: "button", className: "dhac_preset", onClick: () => setRole(preset) }, preset))),
					h("textarea", {
						className: "dhac_textarea",
						value: role,
						placeholder: "例：你负责数据库设计与 SQL 优化，精通 PostgreSQL；独立完成表结构评审与慢查询分析。",
						onChange: (e) => setRole(e.target.value)
					})
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "工作目录"),
					h("input", { className: "dhac_input", value: cwd, placeholder: "默认：当前会话目录", onChange: (e) => setCwd(e.target.value) })
				]),
				h("div", { className: "dhac_hint" }, `将在 ${terminalLabel} 里新建窗口/面板启动；角色简报会自动注入（新建流程自动应答启动期确认弹窗，该点 yes 时点 yes，简报注入成功并验证落地后才算创建完成）`),
				error !== null && h("div", { className: "dhac_error" }, error),
				h("div", { className: "dhac_hint" }, "新建后该智能体会读取工作目录 .deepseek/ 下的 memory.md / task-board.md / experience.md，并遵循团队协作协议（完成后更新 task-board、产出写入 handoffs/、经验沉淀到 experience.md）。")
			]),
			h("div", { className: "dhac_dialogActions" }, [
				h("button", { type: "button", className: "dhac_btn", onClick: onClose, disabled: busy }, "取消"),
				h("button", { type: "button", className: "dhac_btn dhac_btnPrimary", onClick: submit, disabled: busy }, busy ? "创建中…" : "创建并启动")
			])
		])
	]);
}

// ---------------------------------------------------------------------------
// SessionsSection — 会话历史列表（唯一列表）。运行中的会话：绿色边框 + 运行中
// 指示 + 中断/关闭按钮（可点开详情）；未运行：灰色 + 恢复/删除。时间倒序。
// ---------------------------------------------------------------------------
function SessionsSection({ sessions, loading, onRestore, onDelete, onSignal, onCloseAgent, onOpenDetail }) {
	return h("div", { className: "dhac_section" }, [
		sessions.length === 0
			? h("div", { className: "dhac_historyEmpty" }, loading ? "正在扫描会话历史…" : "暂无历史会话（claude / opencode / codex / codebuddy）")
			: h("div", { className: "dhac_historyList" }, sessions.map((sess) => {
				const engine = ENGINE_META[sess.engine]?.label ?? sess.engine;
				const shortId = String(sess.id ?? "").slice(0, 8);
				const ra = sess.runningAgent;
				return h("div", {
					key: `${sess.engine}:${sess.id}`,
					className: `dhac_historyCard${sess.running ? " dhac_historyCardRunning" : ""}`,
					title: sess.running ? "运行中（点击查看详情）" : undefined,
					onClick: sess.running && ra ? () => onOpenDetail(sess) : undefined
				}, [
					h("div", { className: "dhac_historyMain" }, [
						h("div", { className: "dhac_historyTitleRow" }, [
							h("span", { className: "dhac_engineChip", "data-engine": sess.engine }, engine),
							sess.running && h("span", { className: "dhac_runningTag" }, "● 运行中"),
							h("span", { className: "dhac_historyTitle", title: sess.title }, sess.title || `会话 ${shortId}`),
							h("span", { className: "dhac_historyTime", title: fmtTime(sess.time) }, fmtRelative(sess.time))
						]),
						h("div", { className: "dhac_historyMeta" }, [
							h("span", { className: "dhac_historyId", title: `完整会话 ID：${sess.id ?? ""}` }, `ID ${shortId}`),
							Number(sess.tokens) > 0 && h("span", { className: "dhac_historyToken", title: "Token 消耗" }, `⚡ ${fmtTokens(sess.tokens)}`),
							sess.cost !== null && sess.cost !== void 0 && h("span", { className: "dhac_historyCost", title: "成本（估算）" }, `$${Number(sess.cost).toFixed(3)}`),
							sess.running && ra && h("span", { className: "dhac_historyUptime", title: "运行时长" }, `运行 ${fmtUptime(ra.createdAt)}`)
						])
					]),
					h("div", { className: "dhac_historyActions" }, sess.running && ra
						? [
							h("button", { type: "button", className: "dhac_btn dhac_btnSm", title: "中断 (Ctrl+C)", onClick: (e) => { e.stopPropagation(); onSignal(ra.agentId); } }, "中断"),
							h("button", { type: "button", className: "dhac_btn dhac_btnSm dhac_btnDanger", title: "关闭智能体", onClick: (e) => { e.stopPropagation(); onCloseAgent(ra.agentId); } }, "关闭")
						]
						: [
							h("button", { type: "button", className: "dhac_btn dhac_btnPrimary dhac_btnSm", title: "在系统终端新窗口恢复该会话", onClick: () => onRestore(sess) }, "恢复"),
							h("button", { type: "button", className: "dhac_btn dhac_btnSm dhac_btnDanger", title: "删除该会话记录", onClick: () => onDelete(sess) }, "删除")
						])
				]);
			}))
	]);
}

// ---------------------------------------------------------------------------
// TerminalDetail — 运行中 agent 的详情页：工具栏（返回/名称+引擎/状态/压缩
// (仅 claude,codebuddy)/清空/中断/关闭）+ 一行提示 + 底部发送框。系统终端
// 模式不显示实时输出；按键注入可能因缺辅助功能权限失败 → toast 提示。
// ---------------------------------------------------------------------------
function TerminalDetail({ agent, onBack, onCompact, onNewSession, onSignal, onCloseAgent, toast }) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const exited = agent.exited === true || agent.status === "exited";
	const sendText = async () => {
		const text = draft.trim();
		if (text === "" || sending) return;
		setSending(true);
		try {
			await apiPost(`/agents/${encodeURIComponent(agent.id)}/send`, { text, submit: true });
			setDraft("");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			toast(`发送失败：${msg} — 需在系统设置→隐私与安全→辅助功能 授权 DeepSeek Harness`, "exit");
		} finally {
			setSending(false);
		}
	};

	return h("div", { className: "dhac_root" }, [
		h("div", { className: "dhac_toolbar" }, [
			h("button", { type: "button", className: "dhac_iconButton", title: "返回列表", onClick: onBack }, h(Icon, { name: "chevron-left", size: 14 })),
			h("span", { className: "dhac_toolbarName", title: `${agent.name} · ${agent.cwd}` }, `${agent.name} (${agent.type})`),
			h("span", { className: "dhac_statusText", "data-status": agent.status }, STATUS_LABEL[agent.status] ?? agent.status),
			!exited && COMPACT_SUPPORTED.has(agent.type) && h("button", { type: "button", className: "dhac_iconButton", title: "压缩会话（减少上下文）", onClick: () => onCompact(agent.id) }, h(Icon, { name: "minimize", size: 13 })),
			!exited && h("button", { type: "button", className: "dhac_iconButton", title: "清空会话历史", onClick: () => onNewSession(agent.id) }, h(Icon, { name: "rotate-ccw", size: 13 })),
			!exited && h("button", { type: "button", className: "dhac_iconButton", title: "中断 (Ctrl+C)", onClick: () => onSignal(agent.id) }, h(Icon, { name: "stop", size: 13 })),
			!exited && h("button", { type: "button", className: "dhac_iconButton", title: "关闭智能体", onClick: () => { onCloseAgent(agent.id); onBack(); } }, h(Icon, { name: "x", size: 13 }))
		]),
		exited
			? h("div", { className: "dhac_terminalDead" }, [`进程已退出（code ${agent.exitCode ?? "?"}）— 点击「返回」回到列表`])
			: h("div", { className: "dhac_termBody" }, [
				h("div", { className: "dhac_detailInfo" }, [
					h("span", { className: "dhac_statusText", "data-status": agent.status }, STATUS_LABEL[agent.status] ?? agent.status),
					h("span", { className: "dhac_infoItem" }, [h(Icon, { name: "clock", size: 11, className: "dhac_inlineIcon" }), `开启 ${fmtTime(agent.createdAt)}`]),
					h("span", { className: "dhac_infoItem" }, [h(Icon, { name: "stopwatch", size: 11, className: "dhac_inlineIcon" }), `运行 ${fmtUptime(agent.createdAt)}`]),
					agent.terminalApp && h("span", { className: "dhac_infoItem" }, `终端 ${agent.terminalApp}`)
				]),
				h("div", { className: "dhac_detailNote" }, [
					h(Icon, { name: "alert", size: 12, className: "dhac_inlineIcon" }),
					"输出在系统终端窗口查看（本面板不显示实时输出）"
				]),
				h("div", { className: "dhac_sendBox" }, [
					h("input", {
						className: "dhac_input",
						value: draft,
						placeholder: "输入指令，发送到系统终端（需辅助功能权限）…",
						onChange: (e) => setDraft(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") sendText(); }
					}),
					h("button", { type: "button", className: "dhac_btn dhac_btnPrimary", onClick: sendText, disabled: sending }, sending ? "发送中…" : "发送")
				])
			])
	]);
}

// ---------------------------------------------------------------------------
// Safe panel: a render error boundary that shows the error IN the panel and
// does NOT rethrow — the slot renderer only abdicates on errors that escape
// the component, so keeping the error inside keeps us the details winner and
// makes any failure visible instead of silently falling back to the
// conversation details view.
// ---------------------------------------------------------------------------
var SafePanel = class extends react.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error) {
		console.error("[dsh-agent-commander] RadarPanel render error:", error);
	}
	render() {
		if (this.state.error !== null) {
			const error = this.state.error;
			return h("div", {
				style: {
					padding: "16px",
					fontSize: "12px",
					lineHeight: "1.6",
					color: "#f2a1a1",
					whiteSpace: "pre-wrap",
					overflow: "auto",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
				}
			}, `[dsh-agent-commander] 面板渲染错误：\n${error instanceof Error ? error.message : String(error)}\n\n${error instanceof Error && error.stack ? error.stack : ""}`);
		}
		return this.props.children;
	}
};

// ---------------------------------------------------------------------------
// Radar panel — registered into the real "details" column slot
// ---------------------------------------------------------------------------
function RadarPanel(props) {
	const [agents, setAgentsState] = useState(getAgents);
	const [detailAgent, setDetailAgent] = useState(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [toasts, setToasts] = useState([]);
	const [workspaceCwd, setWorkspaceCwd] = useState(void 0);
	const [terminalStatus, setTerminalStatus] = useState(null);
	const [sessions, setSessions] = useState([]);
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	// 1s 心跳：驱动「运行时长」实时走字（不依赖 WS 推送）。
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const { rootRef, onDragStart } = useDetailsColumn();
	const sessionId = props.sessionId;
	// Prefer the definite `sessionId` prop (as DSH's own DetailsPanel does:
	// `useSessions((list) => list.byId[sessionId]?.cwd)`), falling back to the
	// list snapshot's `current` when the prop is absent — `current` can be
	// undefined while `sessionId` is in scope, and vice versa.
	const sessionCwd = typeof props.useSessions === "function"
		? props.useSessions((s) => {
			const id = sessionId !== void 0 ? sessionId : s.current;
			return id !== void 0 ? s.byId[id]?.cwd : void 0;
		})
		: void 0;
	const sessionName = typeof props.useSessions === "function"
		? props.useSessions((s) => {
			const id = sessionId !== void 0 ? sessionId : s.current;
			return id !== void 0 ? s.byId[id]?.title : void 0;
		})
		: void 0;

	const pushToast = useCallback((text, kind) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		setToasts((list) => [...list.slice(-4), { id, text, kind }]);
		setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000);
	}, []);

	// 终端宿主状态（头部徽标 + 新建弹窗的引擎列表/提示）。
	useEffect(() => {
		apiGet("/terminal/status").then((value) => setTerminalStatus(value ?? null)).catch(() => {});
	}, []);

	// 拉取会话历史（cc-switch 式；GET /sessions?cwd=）。
	const loadSessions = useCallback((cwd) => {
		if (typeof cwd !== "string" || cwd === "") {
			setSessions([]);
			return;
		}
		setSessionsLoading(true);
		apiGet(`/sessions?cwd=${encodeURIComponent(cwd)}`)
			.then((value) => setSessions(Array.isArray(value?.sessions) ? value.sessions : []))
			.catch(() => {})
			.finally(() => setSessionsLoading(false));
	}, []);

	// 手动刷新：智能体列表 + 会话历史 + 终端状态。
	const refreshAll = useCallback(() => {
		setRefreshing(true);
		const cwd = workspaceCwd;
		const jobs = [
			apiGet("/terminal/status").then((value) => setTerminalStatus(value ?? null)).catch(() => {}),
			apiGet(typeof cwd === "string" && cwd !== "" ? `/agents?cwd=${encodeURIComponent(cwd)}` : "/agents")
				.then((value) => setAgentsState(Array.isArray(value?.agents) ? value.agents : []))
				.catch(() => {})
		];
		if (typeof cwd === "string" && cwd !== "") jobs.push(loadSessions(cwd));
		Promise.all(jobs).finally(() => setRefreshing(false));
	}, [workspaceCwd, loadSessions]);

	// 工作区切换：重连列表 WS（按 cwd 过滤）+ 拉取会话历史。
	useEffect(() => {
		const cwd = typeof sessionCwd === "string" && sessionCwd !== "" ? sessionCwd : void 0;
		setWorkspaceCwd(cwd);
		setListCwd(cwd);
		setDetailAgent(null);
		loadSessions(cwd ?? "");
	}, [sessionCwd, loadSessions]);

	// 会话历史每 30s 自动刷新（组件卸载清理）。
	useEffect(() => {
		if (typeof workspaceCwd !== "string" || workspaceCwd === "") return;
		const timer = setInterval(() => loadSessions(workspaceCwd), 30000);
		return () => clearInterval(timer);
	}, [workspaceCwd, loadSessions]);

	// 运行中列表 WS 订阅：状态变更 toast（创建/退出/关闭）。cwd 切换时重置
	// diff 基线，避免跨文件夹误报。注入完成（briefing pending→done 或
	// 启动中→运行中）时刷新会话历史 —— 对应「注入成功之后刷新会话历史」。
	const prevRef = useRef([]);
	const prevCwdRef = useRef(void 0);
	useEffect(() => {
		connectListWs();
		const unsub = subscribeAgents((next) => {
			const cwdNow = listCwd;
			const prev = prevCwdRef.current === cwdNow ? prevRef.current : [];
			prevCwdRef.current = cwdNow;
			prevRef.current = next;
			if (prev.length > 0) {
				const byId = new Map(prev.map((a) => [a.id, a]));
				let briefingDone = false;
				for (const agent of next) {
					const old = byId.get(agent.id);
					if (old === void 0) {
						pushToast(`智能体 ${agent.name}（${agent.type}）已在终端窗口启动`, "create");
					} else {
						if (old.status !== "exited" && agent.status === "exited") {
							pushToast(`智能体 ${agent.name} 已退出`, "exit");
						}
						const started = old.status === "starting" && agent.status !== "starting";
						const injected = old.briefing === "pending" && agent.briefing === "done";
						if (started || injected) briefingDone = true;
					}
				}
				for (const agent of prev) {
					if (!next.some((a) => a.id === agent.id)) pushToast(`智能体 ${agent.name} 已关闭`, "exit");
				}
				if (briefingDone && typeof cwdNow === "string" && cwdNow !== "") {
					loadSessions(cwdNow);
				}
			}
			setAgentsState(next);
		});
		return unsub;
	}, [pushToast, loadSessions]);

	// ---- 运行中 agent 操作 ----
	const signalAgent = useCallback(async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/signal`, { signal: "SIGINT" });
			pushToast("已发送 SIGINT 中断", "done");
		} catch (err) {
			pushToast(`中断失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
	}, [pushToast]);

	const closeAgent = useCallback(async (id) => {
		try {
			await apiDelete(`/agents/${encodeURIComponent(id)}?graceful=1`);
			pushToast("已关闭智能体", "done");
		} catch (err) {
			pushToast(`关闭失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
	}, [pushToast]);

	const compactSession = useCallback(async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/compact`, {});
			pushToast("已发送压缩指令（/compact）", "done");
		} catch (err) {
			pushToast(`压缩失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
	}, [pushToast]);

	const newSession = useCallback(async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/new-session`, {});
			pushToast("已清空会话", "done");
		} catch (err) {
			pushToast(`清空失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
	}, [pushToast]);

	// ---- 会话历史操作 ----
	const restoreSession = useCallback(async (sess) => {
		try {
			await apiPost("/sessions/restore", { engine: sess.engine, id: sess.id, cwd: workspaceCwd, name: sess.title });
			pushToast(`已在新终端窗口恢复「${String(sess.title || sess.id).slice(0, 24)}」`, "done");
			loadSessions(workspaceCwd);
		} catch (err) {
			pushToast(`恢复失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
	}, [workspaceCwd, pushToast, loadSessions]);

	const deleteSession = useCallback(async (sess) => {
		if (!window.confirm(`确定删除该 ${sess.engine} 会话？\n${sess.title || sess.id}`)) return;
		try {
			const qs = typeof workspaceCwd === "string" && workspaceCwd !== "" ? `?cwd=${encodeURIComponent(workspaceCwd)}` : "";
			await apiDelete(`/sessions/${encodeURIComponent(sess.engine)}/${encodeURIComponent(sess.id)}${qs}`);
			setSessions((list) => list.filter((s) => !(s.engine === sess.engine && s.id === sess.id)));
			pushToast("会话已删除", "done");
		} catch (err) {
			pushToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
	}, [workspaceCwd, pushToast]);

	const onAgentCreated = useCallback((agent) => {
		pushToast(`智能体 ${agent?.name ?? ""}（${agent?.type ?? ""}）已在终端窗口启动`, "create");
		refreshAll();
	}, [pushToast, refreshAll]);

	const detail = detailAgent;
	const openSessionDetail = useCallback((sess) => {
		const ra = sess.runningAgent;
		if (!ra) return;
		setDetailAgent({
			id: ra.agentId,
			type: ra.type ?? sess.engine,
			name: ra.name ?? sess.title ?? sess.engine,
			cwd: ra.cwd ?? workspaceCwd,
			status: ra.status ?? "working",
			exited: false,
			exitCode: null,
			pid: ra.pid ?? null,
			sessionId: ra.sessionId ?? sess.id,
			createdAt: ra.createdAt ?? Date.now(),
			briefing: "none",
			external: false
		});
	}, [workspaceCwd]);
	const workspaceLabel = workspaceCwd !== void 0
		? (workspaceCwd.split("/").filter(Boolean).pop() || workspaceCwd)
		: "全部工作区";

	return h("div", { ref: rootRef, className: "dhac_root" }, [
		h("div", { className: "dhac_resizeHandle", title: "拖拽调整宽度", onPointerDown: onDragStart }),
		h("div", { className: "dhac_header" }, [
			h("span", { className: "dhac_headerTitle" }, "智能体雷达"),
			h("span", { className: "dhac_count" }, String(sessions.length)),
			h("button", { type: "button", className: "dhac_iconButton", title: "刷新（智能体 + 会话历史）", onClick: refreshAll, disabled: refreshing },
				h(Icon, { name: "refresh-cw", size: 13, className: refreshing ? "dhac_spin" : "" })),
			h("button", { type: "button", className: "dhac_addButton", onClick: () => setDialogOpen(true) }, [
				h(Icon, { name: "plus", size: 13 }),
				h("span", null, "新建")
			])
		]),
		h("div", { className: "dhac_workspace", title: workspaceCwd ?? "未绑定工作区（显示全部智能体）" }, [
			h(Icon, { name: "folder", size: 12, className: "dhac_inlineIcon" }),
			h("span", null, workspaceCwd !== void 0
				? `${workspaceLabel} · ${sessions.length} 个会话${sessionsLoading ? " · 扫描中…" : ""}`
				: workspaceLabel)
		]),
		h("div", { className: "dhac_toasts" },
			toasts.map((t) =>
				h("div", { key: t.id, className: `dhac_toast dhac_toast_${t.kind}` }, t.text))),
		h("div", { className: "dhac_body" },
			detail !== null
				? h(TerminalDetail, {
					agent: detail,
					onBack: () => setDetailAgent(null),
					onCompact: compactSession,
					onNewSession: newSession,
					onSignal: signalAgent,
					onCloseAgent: closeAgent,
					toast: pushToast
				})
				: h("div", { className: "dhac_panel" }, [
					h(SessionsSection, {
						sessions,
						loading: sessionsLoading,
						onRestore: restoreSession,
						onDelete: deleteSession,
						onSignal: signalAgent,
						onCloseAgent: closeAgent,
						onOpenDetail: openSessionDetail
					})
				])),
		dialogOpen &&
			h(NewAgentDialog, {
				terminalStatus,
				sessionId,
				sessionName,
				defaultCwd: sessionCwd,
				onClose: () => setDialogOpen(false),
				onCreated: onAgentCreated
			})
	]);
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
const inject = ["slots", "layout", "sessions"];

function fail(phase, error) {
	console.error(`[dsh-agent-commander] ${phase} error:`, error);
	try {
		const bar = document.createElement("div");
		bar.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap";
		bar.textContent = `[dsh-agent-commander] ${phase} error: ${error instanceof Error ? error.message : String(error)}`;
		document.body.appendChild(bar);
	} catch {}
}

function apply(ctx) {
	try {
		// Standard programmatic API: window.dshAgentCommander — exposed for other
		// plugins / user scripts. Methods: list/open/send/read/approve/signal/
		// close/status + memory.list/search/add + onStatus(listener).
		ctx.effect(() => {
			const api = {
				list: (cwd) => apiGet(typeof cwd === "string" && cwd !== "" ? `/agents?cwd=${encodeURIComponent(cwd)}` : "/agents").then((v) => v?.agents ?? []),
				scan: (cwd) => apiPost("/agents/scan", { cwd }).then((v) => v?.agents ?? []),
				open: (opts) => apiPost("/agents", opts).then((v) => v?.agent),
				send: (id, text, submit) => apiPost(`/agents/${encodeURIComponent(id)}/send`, { text, submit: submit === true }),
				read: (id, bytes) => apiGet(`/agents/${encodeURIComponent(id)}/read?bytes=${Number.isFinite(bytes) ? bytes : 12000}`),
				approve: (id, choice) => apiPost(`/agents/${encodeURIComponent(id)}/approve`, { choice }),
				signal: (id, signal) => apiPost(`/agents/${encodeURIComponent(id)}/signal`, { signal }),
				close: (id, graceful) => apiDelete(`/agents/${encodeURIComponent(id)}?graceful=${graceful === false ? "0" : "1"}`),
				status: (id) => apiGet(`/agents/${encodeURIComponent(id)}/status`),
				newSession: (id) => apiPost(`/agents/${encodeURIComponent(id)}/new-session`, {}),
				compactSession: (id) => apiPost(`/agents/${encodeURIComponent(id)}/compact`, {}),
				restore: (id, cwd) => apiPost(`/agents/${encodeURIComponent(id)}/restore`, { cwd }).then((v) => v?.agent),
				forget: (id, cwd) => apiPost(`/agents/${encodeURIComponent(id)}/forget`, { cwd }).then((v) => v?.removed === true),
				memory: {
					list: (ns) => apiGet(`/memory${ns ? `?namespace=${encodeURIComponent(ns)}` : ""}`).then((v) => v?.entries ?? []),
					search: (q) => apiGet(`/memory/search?q=${encodeURIComponent(q)}`).then((v) => v?.entries ?? []),
					add: (entry) => apiPost("/memory", entry)
				},
				onStatus: (fn) => {
					agentListeners.add(fn);
					return () => agentListeners.delete(fn);
				}
			};
			try {
				globalThis.__dshAgentCommander__ = api;
				window.dshAgentCommander = api;
			} catch {}
			return () => {
				try {
					if (window.dshAgentCommander === api) delete window.dshAgentCommander;
				} catch {}
			};
		}, "dsh-agent-commander: global api");
		ctx.effect(() => {
			// Global safety net: keep the details column track open even if the
			// panel itself ever crashes — decoupled from RadarPanel's lifecycle.
			const enforce = () => {
				// Reset the rAF guard first — without this the observer is
				// one-shot: after the first mutation raf stays truthy and every
				// later schedule() no-ops, so switching to a new (blank) session
				// zeroes the details track and the sidebar never comes back.
				raf = 0;
				try {
					if (isPanelCollapsed()) return;
					const outlet = document.querySelector('[data-slot="details"]');
					const column = outlet?.parentElement;
					const frame = column?.parentElement;
					if (frame === null || frame === void 0) return;
					const style = frame.style.gridTemplateColumns;
					if (typeof style !== "string" || style === "") return;
					const last = style.match(/(\S+)\s*$/)?.[1];
					if (last === "0px" || last === "0") {
						const w = Number(localStorage.getItem(PANEL_WIDTH_KEY));
						const width = Number.isFinite(w) && w >= 280 && w <= 620 ? w : PANEL_WIDTH_DEFAULT;
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${width}px`);
						frame.removeAttribute("data-details-collapsed");
					}
				} catch {}
			};
			let raf = 0;
			const schedule = () => {
				if (raf === 0) raf = requestAnimationFrame(enforce);
			};
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style", "data-details-collapsed"] });
			schedule();
			return () => {
				observer.disconnect();
				if (raf !== 0) cancelAnimationFrame(raf);
			};
		}, "dsh-agent-commander: global column enforcement");
		// Helper: find the AppFrame grid element and enforce details column width.
		function enforceDetailsWidth(forceOpen) {
			try {
				// Try multiple selectors to find the grid frame.
				const outlet = document.querySelector('[data-slot="details"]')
					|| document.querySelector('.detailsCol')
					|| document.querySelector('[class*="details"]');
				const column = outlet?.parentElement;
				const frame = column?.parentElement;
				if (!frame) return;
				const style = frame.style.gridTemplateColumns;
				if (typeof style !== "string" || style === "") return;
				const last = style.match(/(\S+)\s*$/)?.[1];
				if (forceOpen) {
					if (last === "0px" || last === "0") {
						const w = Number(localStorage.getItem(PANEL_WIDTH_KEY));
						const width = Number.isFinite(w) && w >= 280 && w <= 620 ? w : PANEL_WIDTH_DEFAULT;
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${width}px`);
						frame.removeAttribute("data-details-collapsed");
					}
				} else {
					if (last !== "0px" && last !== "0") {
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, "0px");
						frame.setAttribute("data-details-collapsed", "");
					}
				}
			} catch {}
		}
		// Periodic enforcement: keeps sidebar open unless user collapsed it.
		ctx.effect(() => {
			const timer = setInterval(() => {
				if (!isPanelCollapsed()) enforceDetailsWidth(true);
			}, 800);
			return () => clearInterval(timer);
		}, "dsh-agent-commander: periodic enforcement");
		// Floating toggle button on the main interface: always visible, clicks
		// pop the Agent Radar sidebar in / out. It auto-positions just LEFT of
		// the details column when the panel is open (so it never covers the
		// radar's own header), otherwise at the window's right edge.
		ctx.effect(() => {
			const cluster = document.createElement("div");
			cluster.className = "dhac_toggleCluster";
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "dhac_toggleButton";
			btn.title = "智能体雷达（点击弹出/收起侧边栏）";
			const icon = document.createElement("span");
			icon.className = "dhac_toggleIcon";
			icon.innerHTML = iconSvgMarkup("bot", 15);
			const label = document.createElement("span");
			label.className = "dhac_toggleLabel";
			label.textContent = "雷达";
			btn.appendChild(icon);
			btn.appendChild(label);
			btn.addEventListener("click", () => {
				const collapsed = isPanelCollapsed();
				if (collapsed) {
					// Pop the sidebar open.
					setPanelCollapsed(false);
					enforceDetailsWidth(true);
					try { ctx.layout.openDetails(); } catch {}
				} else {
					// Collapse it again.
					setPanelCollapsed(true);
					enforceDetailsWidth(false);
					try { ctx.layout.closeDetails(); } catch {}
				}
				sync();
			});
			cluster.appendChild(btn);
			document.body.appendChild(cluster);
			// Read the frame's current details track width (0 = closed).
			const detailsWidth = () => {
				try {
					const outlet = document.querySelector('[data-slot="details"]');
					const frame = outlet?.parentElement?.parentElement;
					if (!frame) return 0;
					const style = frame.style.gridTemplateColumns;
					if (typeof style !== "string" || style === "") return 0;
					const last = style.match(/(\S+)\s*$/)?.[1];
					if (last === void 0 || last === "0px" || last === "0") return 0;
					const n = Number.parseFloat(last);
					return Number.isFinite(n) && n > 0 ? n : 0;
				} catch {
					return 0;
				}
			};
			// Keep the button next to the details column edge (never on top of it).
			const sync = () => {
				try {
					const w = detailsWidth();
					const open = !isPanelCollapsed() && w > 0;
					cluster.style.right = `${w > 0 ? w + 10 : 12}px`;
					cluster.classList.toggle("dhac_toggleCluster_open", open);
				} catch {}
			};
			sync();
			const syncTimer = setInterval(sync, 600);
			let raf = 0;
			const scheduleSync = () => {
				if (raf === 0) raf = requestAnimationFrame(() => {
					raf = 0;
					sync();
				});
			};
			const observer = new MutationObserver(scheduleSync);
			observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style", "data-details-collapsed"] });
			return () => {
				clearInterval(syncTimer);
				observer.disconnect();
				if (raf !== 0) cancelAnimationFrame(raf);
				cluster.remove();
			};
		}, "dsh-agent-commander: toggle button");
		ctx.effect(() => {
			// Register the RadarPanel into the details slot and try to open it.
			if (!isPanelCollapsed()) {
				try { ctx.layout.openDetails(); } catch {}
			}
			let disposeRegistration = () => {};
			try {
				disposeRegistration = ctx.slots.register({
					name: "details",
					priority: -100
				}, RadarPanelSafe);
				console.info("[dsh-agent-commander] registered into details slot");
			} catch (error) {
				fail("register", error);
			}
			return () => {
				disposeRegistration();
			};
		}, "dsh-agent-commander: details registration");
	} catch (error) {
		fail("load", error);
	}
}

const RadarPanelSafe = (props) => h(SafePanel, null, h(RadarPanel, props));
