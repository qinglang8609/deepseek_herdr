// ============================================================================
// dsh-agent-commander — client application (plain JS + React createElement)
//
// Registers the "Agent Radar" panel into the app's real right "details"
// column (no floating overlay):
//   • list every open agent with live status (working / idle / blocked / exited)
//   • click an agent to open its live terminal (vendored xterm + WebSocket)
//   • "+ 新建智能体" dialog: engine (claude/opencode/codex), name, role
//     definition with presets, skill attachments, working directory
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
	"trash": [["path", { d: "M3 6h18" }], ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }], ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }], ["path", { d: "M10 11v6" }], ["path", { d: "M14 11v6" }]],
	"minimize": [["path", { d: "m14 10 7-7" }], ["path", { d: "M20 10h-6V4" }], ["path", { d: "m3 21 7-7" }], ["path", { d: "M4 14h6v6" }]],
	"folder": [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
	"clock": [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 6v6l4 2" }]],
	"alert": [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
	"chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
	"chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
	"plus": [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
	"stop": [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2, fill: "currentColor", stroke: "none" }]],
	"bot": [["path", { d: "M12 8V4H8" }], ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }], ["path", { d: "M2 14h2" }], ["path", { d: "M20 14h2" }], ["path", { d: "M15 13v2" }], ["path", { d: "M9 13v2" }]]
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
// Session history store (cc-switch 式): module-level, shared across mounts.
// Subscribes to /agent-commander/ws/sessions?cwd= — the server rebuilds the
// list on its poll interval and pushes only when the status signature changes.
// ---------------------------------------------------------------------------
const sessionListeners = new Set();
let sessionSnapshot = [];
let sessionsWs = null;
let sessionsCwd = void 0;
function setSessions(next) {
	sessionSnapshot = Array.isArray(next) ? next : [];
	for (const fn of [...sessionListeners]) fn(sessionSnapshot);
}
function getSessions() {
	return sessionSnapshot;
}
function subscribeSessions(fn) {
	sessionListeners.add(fn);
	fn(sessionSnapshot);
	return () => {
		sessionListeners.delete(fn);
		if (sessionListeners.size === 0 && sessionsWs !== null) {
			try {
				sessionsWs.close();
			} catch {}
			sessionsWs = null;
		}
	};
}
function setSessionsCwd(cwd) {
	const next = typeof cwd === "string" && cwd !== "" ? cwd : void 0;
	if (next === sessionsCwd) return;
	sessionsCwd = next;
	if (sessionsWs !== null) {
		try {
			sessionsWs.close();
		} catch {}
		sessionsWs = null;
	}
	connectSessionsWs();
}
let sessionsConnecting = false;
function connectSessionsWs() {
	if (sessionsConnecting) return;
	if (sessionsWs !== null && (sessionsWs.readyState === WebSocket.CONNECTING || sessionsWs.readyState === WebSocket.OPEN)) return;
	sessionsConnecting = true;
	let ws;
	const open = () => {
		if (sessionsWs !== null && (sessionsWs.readyState === WebSocket.CONNECTING || sessionsWs.readyState === WebSocket.OPEN)) {
			sessionsConnecting = false;
			return;
		}
		const qs = sessionsCwd !== void 0 ? `?cwd=${encodeURIComponent(sessionsCwd)}` : "";
		ws = new WebSocket(wsUrl(`/agent-commander/ws/sessions${qs}`));
		sessionsWs = ws;
		ws.onmessage = (e) => {
			try {
				const data = JSON.parse(e.data);
				if (data && Array.isArray(data.sessions)) setSessions(data.sessions);
			} catch {}
		};
		ws.onclose = () => {
			if (sessionsWs === ws) sessionsWs = null;
			sessionsConnecting = false;
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
// Status labels
// ---------------------------------------------------------------------------
const STATUS_LABEL = {
	working: "工作中",
	idle: "空闲",
	blocked: "受阻",
	closing: "退出中…",
	exited: "已退出"
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
// Terminal view (vendored xterm + addon-fit + WebSocket bridge)
// ---------------------------------------------------------------------------
const AGENT_TYPES = ["claude", "opencode", "codex", "codebuddy", "pi", "qwen"];
const COMPACT_SUPPORTED = new Set(["claude", "codebuddy", "qwen"]);
const DEFAULT_ROLE_PRESETS = ["数据库专家", "设计专家", "前端专家", "测试专家", "代码审查专家", "架构师"];

// ---------------------------------------------------------------------------
// Runtime config (mirror of the server-side Config schema, fetched lazily).
// The 新建智能体 dialog uses server-configured rolePresets when available,
// falling back to the built-in presets — so a user can add presets from
// cordis.yml without touching client code (plugin standard: no hardcoded
// tunables). Also exposes agentTypes/limits for other client plugins.
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
// ResizeObserver throttle helper — shared by AgentTerminal & MiniTerminal.
// Coalesces rapid resize events into at most one callback per 200ms window.
// ---------------------------------------------------------------------------
function makeThrottledResizeObserver(callbacks) {
	let throttleTimer = null;
	const observer = new ResizeObserver(() => {
		if (throttleTimer !== null) return;
		throttleTimer = setTimeout(() => {
			throttleTimer = null;
			for (const fn of callbacks) { try { fn(); } catch {} }
		}, 200);
	});
	return {
		observe(target) { observer.observe(target); },
		disconnect() {
			if (throttleTimer !== null) { clearTimeout(throttleTimer); throttleTimer = null; }
			observer.disconnect();
		}
	};
}

function AgentTerminal({ agentId, signalRef }) {
	const containerRef = useRef(null);
	const wsRef = useRef(null);
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		const { Terminal } = require_xterm();
		const { FitAddon } = require_addon_fit();
		const term = new Terminal({
			scrollback: 10000,
			cursorBlink: true,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
			fontSize: 13,
			theme: {
				background: "#0b0b10",
				foreground: "#d6deeb",
				cursor: "#82aaff",
				cursorAccent: "#0b0b10",
				selectionBackground: "#2d3a5f",
				black: "#0b0b10",
				red: "#ff7b72",
				green: "#3fb950",
				yellow: "#e3b341",
				blue: "#82aaff",
				magenta: "#d2a8ff",
				cyan: "#39c5cf",
				white: "#d6deeb",
				brightBlack: "#4a4a5a",
				brightRed: "#ff7b72",
				brightGreen: "#3fb950",
				brightYellow: "#e3b341",
				brightBlue: "#82aaff",
				brightMagenta: "#d2a8ff",
				brightCyan: "#39c5cf",
				brightWhite: "#ffffff"
			}
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		try {
			fit.fit();
		} catch {}

		let closed = false;
		let ws = null;
		let retry = 0;
		let reconnectTimer = null;
		let pinTimer = null;
		const isAtBottom = () => {
			try {
				const buffer = term.buffer.active;
				return buffer.baseY - buffer.viewY <= 1;
			} catch {
				return true;
			}
		};
		const pinToBottom = () => {
			if (pinTimer !== null) return;
			pinTimer = setTimeout(() => {
				pinTimer = null;
				try {
					if (isAtBottom()) term.scrollToBottom();
				} catch {}
			}, 60);
		};
		const sendResize = () => {
			if (ws === null || ws.readyState !== WebSocket.OPEN) return;
			try {
				const dims = fit.proposeDimensions();
				if (dims !== void 0) ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
			} catch {}
		};
		const connect = () => {
			if (closed) return;
			ws = new WebSocket(wsUrl(`/agent-commander/ws/terminal?id=${encodeURIComponent(agentId)}`));
			wsRef.current = ws;
			ws.onopen = () => {
				retry = 0;
				setConnected(true);
				sendResize();
				term.focus();
			};
			ws.onmessage = (e) => {
				const write = (text) => {
					term.write(text, pinToBottom);
				};
				if (typeof e.data === "string") write(e.data);
				else e.data.text().then(write).catch(() => {});
			};
			ws.onclose = () => {
				setConnected(false);
				if (closed) return;
				retry = Math.min(retry + 1, 6);
				reconnectTimer = setTimeout(connect, 500 * 2 ** retry);
			};
			ws.onerror = () => {
				try {
					ws.close();
				} catch {}
			};
		};
		const dataDisposable = term.onData((data) => {
			if (ws !== null && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "input", data }));
			}
		});
		const resizeObserver = makeThrottledResizeObserver([fit.fit, sendResize, pinToBottom]);
		resizeObserver.observe(container);
		connect();
		return () => {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			if (pinTimer !== null) clearTimeout(pinTimer);
			resizeObserver.disconnect();
			dataDisposable.dispose();
			try {
				ws?.close();
			} catch {}
			wsRef.current = null;
			term.dispose();
		};
	}, [agentId]);

	const sendSignal = useCallback((signal) => {
		if (wsRef.current !== null && wsRef.current.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "signal", signal }));
		}
	}, []);
	useEffect(() => {
		if (signalRef !== void 0) signalRef.current = sendSignal;
		return () => { if (signalRef !== void 0) signalRef.current = void 0; };
	}, [signalRef, sendSignal]);

	return h("div", { className: "dhac_terminalWrap" }, [
		h("div", { className: "dhac_terminalBanner" }, [
			h("span", { className: `dhac_termDot${connected ? " dhac_termDotOn" : ""}` }),
			h("span", null, connected ? "已连接" : "连接中…"),
			h("span", { style: { flex: "1" } })
		]),
		h("div", { ref: containerRef, className: "dhac_terminal" })
	]);
}

// ---------------------------------------------------------------------------
// New-agent dialog
// ---------------------------------------------------------------------------
function NewAgentDialog({ sessionId, sessionName, workspaceId, defaultCwd, onClose, onCreated }) {
	const [type, setType] = useState("opencode");
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [cwd, setCwd] = useState(defaultCwd ?? "");
	const [binaries, setBinaries] = useState([]);
	const [rolePresets, setRolePresets] = useState(DEFAULT_ROLE_PRESETS);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		apiGet("/binaries").then((value) => setBinaries(value?.binaries ?? [])).catch(() => {});
		getPluginConfig().then(() => setRolePresets(getRolePresets()));
	}, []);

	const submit = async () => {
		if (busy) return;
		if (type === "") {
			setError("请选择智能体引擎（claude / opencode / codex）");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const body = await apiPost("/agents", { sessionId, sessionName, workspaceId, type, name, role, cwd });
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
						AGENT_TYPES.map((t) => {
							const info = binaries.find((b) => b.type === t);
							const available = info?.available === true;
							return h("option", { key: t, value: t, disabled: !available }, available ? t : `${t}（未安装）`);
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
// Mini live terminal card (display-only xterm streaming the agent's output)
// ---------------------------------------------------------------------------
function MiniTerminal({ agentId }) {
	const containerRef = useRef(null);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		const { Terminal } = require_xterm();
		const { FitAddon } = require_addon_fit();
		const term = new Terminal({
			scrollback: 800,
			fontSize: 11,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
			disableStdin: true,
			convertEol: true,
			theme: {
				background: "#0b0b10",
				foreground: "#d6deeb",
				cursor: "#82aaff",
				cursorAccent: "#0b0b10",
				selectionBackground: "#2d3a5f",
				black: "#0b0b10",
				red: "#ff7b72",
				green: "#3fb950",
				yellow: "#e3b341",
				blue: "#82aaff",
				magenta: "#d2a8ff",
				cyan: "#39c5cf",
				white: "#d6deeb",
				brightBlack: "#4a4a5a",
				brightRed: "#ff7b72",
				brightGreen: "#3fb950",
				brightYellow: "#e3b341",
				brightBlue: "#82aaff",
				brightMagenta: "#d2a8ff",
				brightCyan: "#39c5cf",
				brightWhite: "#ffffff"
			}
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		try {
			fit.fit();
		} catch {}

		let closed = false;
		let ws = null;
		let retry = 0;
		let reconnectTimer = null;
		let pinTimer = null;
		// Scroll AFTER the write finished rendering — xterm renders large writes
		// over several frames, so an immediate scrollToBottom lands mid-buffer.
		const pinToBottom = () => {
			if (pinTimer !== null) return;
			pinTimer = setTimeout(() => {
				pinTimer = null;
				try {
					term.scrollToBottom();
				} catch {}
			}, 60);
		};
		// Force the PTY to the card's tiny size — the thumbnail only displays
		// correctly when the terminal window itself shrinks to the card dims.
		// (The full detail view resizes it back when opened.)
		const sendResize = () => {
			if (ws === null || ws.readyState !== WebSocket.OPEN) return;
			try {
				const dims = fit.proposeDimensions();
				if (dims !== void 0 && dims.cols > 0 && dims.rows > 0) {
					ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
				}
			} catch {}
		};
		let writeBuffer = "";
		let flushTimer = null;
		const flushWrites = () => {
			flushTimer = null;
			if (writeBuffer === "") return;
			const text = writeBuffer;
			writeBuffer = "";
			term.write(text, pinToBottom);
		};
		const enqueueWrite = (text) => {
			writeBuffer += text;
			if (flushTimer === null) flushTimer = setTimeout(flushWrites, 16);
		};
		const connect = () => {
			if (closed) return;
			ws = new WebSocket(wsUrl(`/agent-commander/ws/terminal?id=${encodeURIComponent(agentId)}`));
			ws.onopen = () => {
				retry = 0;
				sendResize();
			};
			ws.onmessage = (e) => {
				const write = (text) => enqueueWrite(text);
				if (typeof e.data === "string") write(e.data);
				else e.data.text().then(write).catch(() => {});
			};
			ws.onclose = () => {
				if (closed) return;
				retry = Math.min(retry + 1, 6);
				reconnectTimer = setTimeout(connect, 500 * 2 ** retry);
			};
			ws.onerror = () => {
				try {
					ws.close();
				} catch {}
			};
		};
		connect();
		const resizeObserver = makeThrottledResizeObserver([fit.fit, sendResize, pinToBottom]);
		resizeObserver.observe(container);
		return () => {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			if (pinTimer !== null) clearTimeout(pinTimer);
			if (flushTimer !== null) clearTimeout(flushTimer);
			resizeObserver.disconnect();
			try {
				ws?.close();
			} catch {}
			term.dispose();
		};
	}, [agentId]);

	return h("div", { ref: containerRef, className: "dhac_miniTerm" });
}

// ---------------------------------------------------------------------------
// Agent cards (live mini-terminal per agent)
// ---------------------------------------------------------------------------
function AgentCards({ agents, scoped, onOpen, onCompact, onNewSession, onCloseAgent, onRestore, onForget, onRefresh }) {
	if (agents.length === 0) {
		return h("div", { className: "dhac_empty" }, [
			h("div", null, scoped ? "本文件夹还没有智能体" : "还没有智能体"),
			h("div", { className: "dhac_emptyHint" }, "点击右上角「新建」打开 claude / opencode / codex，或让 DeepSeek 用 agent_open 工具创建"),
			h("div", { className: "dhac_emptyHint" }, "智能体共享记忆：.deepseek/memory.md · task-board.md · experience.md · handoffs/")
		]);
	}
	return h("div", { className: "dhac_cards" }, agents.map((agent) => {
		const ghost = agent.running === false;
		return h("div", {
			key: agent.id,
			className: "dhac_card",
			onClick: () => onOpen(agent)
		}, [
			h("div", { className: "dhac_cardHeader" }, [
				h("span", { className: "dhac_statusDot", "data-status": ghost ? "exited" : agent.status }),
				h("span", { className: "dhac_agentName", title: agent.role || agent.cwd }, agent.name),
				h("span", { className: "dhac_agentType" }, agent.type),
				h("span", { className: "dhac_agentMeta" }, ghost ? "已保存·未运行" : (STATUS_LABEL[agent.status] ?? agent.status)),
				ghost
					? h("span", { style: { display: "contents" } }, [
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "重新启动该智能体（恢复会话）",
							onClick: (e) => {
								e.stopPropagation();
								onRestore(agent.id);
							}
						}, h(Icon, { name: "power", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "删除该保存记录（从 .deepseek/agents.json 移除）",
							onClick: (e) => {
								e.stopPropagation();
								onForget(agent.id);
							}
						}, h(Icon, { name: "x", size: 12 }))
					])
					: h("span", { style: { display: "contents" } }, [
						COMPACT_SUPPORTED.has(agent.type) && h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "压缩会话（减少上下文）",
							onClick: (e) => {
								e.stopPropagation();
								onCompact(agent.id);
							}
						}, h(Icon, { name: "minimize", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "刷新会话历史列表",
							onClick: (e) => {
								e.stopPropagation();
								if (typeof onRefresh === "function") onRefresh();
							}
						}, h(Icon, { name: "refresh-cw", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "清空会话历史（在智能体中执行 /clear 或 /new，开始新对话）",
							onClick: (e) => {
								e.stopPropagation();
								onNewSession(agent.id);
							}
						}, h(Icon, { name: "trash", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "关闭智能体",
							onClick: (e) => {
								e.stopPropagation();
								onCloseAgent(agent.id);
							}
						}, h(Icon, { name: "x", size: 12 }))
					])
			]),
			agent.role !== "" && h("div", { className: "dhac_agentRole", title: agent.role }, agent.role),
			(agent.briefing === "pending" || agent.briefing === "failed") && h("div", {
				className: agent.briefing === "failed" ? "dhac_briefing dhac_briefingFailed" : "dhac_briefing",
				title: "角色/技能简报会在智能体启动就绪后自动写入并回车执行"
			}, [
				h(Icon, { name: agent.briefing === "pending" ? "clock" : "alert", size: 11, className: "dhac_inlineIcon" }),
				agent.briefing === "pending" ? "简报注入中（等待启动就绪后自动回车执行）…" : "简报未能确认执行，请打开终端检查"
			]),
			ghost
				? h("div", { className: "dhac_cardExited" }, [
					"未运行（恢复失败或已关闭）— ",
					h(Icon, { name: "power", size: 11, className: "dhac_inlineIcon" }),
					" 恢复 / ",
					h(Icon, { name: "x", size: 11, className: "dhac_inlineIcon" }),
					" 删除记录"
				])
				: (agent.exited
					? h("div", { className: "dhac_cardExited" }, `进程已退出 (code ${agent.exitCode ?? "?"}) — 点击重新创建`)
					: h("div", { className: "dhac_miniTermWrap" }, h(MiniTerminal, { agentId: agent.id })))
		]);
	}));
}

function SessionStatusChip({ status }) {
	if (status === "running") return h("span", { className: "dhac_sessChip dhac_sessChipRun", title: "运行中" }, "运行中");
	if (status === "starting") return h("span", { className: "dhac_sessChip", title: "启动中" }, "启动中");
	if (status === "exited") return h("span", { className: "dhac_sessChip dhac_sessChipExit", title: "已退出" }, "已退出");
	return null;
}

function relativeTime(ms) {
	if (!Number.isFinite(ms)) return "";
	const d = Date.now() - ms;
	if (d < 60000) return "刚刚";
	if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
	if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
	return `${new Date(ms).toLocaleDateString?.() ?? Math.floor(d / 86400000) + " 天前"}`;
}

function fmtTokens(n) {
	if (!Number.isFinite(n)) return "0";
	return n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const SESSIONS_PAGE_SIZE = 20;

function SessionsSection({ sessions, loading, onRestore, onDelete, onLiveClose, onRefresh }) {
	const [page, setPage] = useState(1);
	const total = sessions.length;
	const totalPages = Math.max(1, Math.ceil(total / SESSIONS_PAGE_SIZE));
	const safePage = Math.min(page, totalPages);
	const slice = sessions.slice((safePage - 1) * SESSIONS_PAGE_SIZE, safePage * SESSIONS_PAGE_SIZE);
	return h("div", { className: "dhac_sessions" }, [
		h("div", { className: "dhac_sessionsTitleRow" }, [
			h("span", { className: "dhac_sessionsTitle" }, `会话历史 · ${total}`),
			h("button", { type: "button", className: "dhac_iconBtn", title: "刷新会话历史", onClick: () => onRefresh(), disabled: loading },
				h(Icon, { name: "refresh-cw", size: 13, className: loading ? "dhac_spin" : "" }))
		]),
		sessions.length === 0
			? h("div", { className: "dhac_emptyHint" }, loading ? "正在读取会话历史…" : "暂无可恢复的持久会话（claude / opencode / codex / codebuddy）")
			: h("div", { className: "dhac_cards" }, slice.map((sess) => {
				const running = sess.running === true;
				return h("div", {
					key: `${sess.engine}:${sess.id}`,
					className: `dhac_card dhac_sessCard${running ? " dhac_sessCardRun" : ""}`,
					title: running ? "运行中 · 已恢复" : "历史会话"
				}, [
					h("div", { className: "dhac_cardHeader" }, [
						h("span", { className: "dhac_statusDot", "data-status": running ? "working" : "idle" }),
						h("span", { className: "dhac_agentName", title: sess.title ?? String(sess.id) }, sess.title || `会话 ${String(sess.id).slice(0, 8)}`),
						h("span", { className: "dhac_engineChip", "data-engine": sess.engine, title: `引擎：${sess.engine}` }, sess.engine),
						h(SessionStatusChip, { status: sess.status })
					]),
					h("div", { className: "dhac_agentMeta" }, [
						`ID ${String(sess.id).slice(0, 8)}`,
						Number(sess.tokens) > 0 ? ` · ⚡ ${fmtTokens(sess.tokens)}` : "",
						sess.cost !== null && sess.cost !== void 0 ? ` · $${Number(sess.cost).toFixed(3)}` : "",
						` · ${relativeTime(sess.time)}`
					]),
					h("div", { className: "dhac_sessFooter" }, [
						h("button", { type: "button", className: "dhac_btn dhac_btnSm", title: running ? "该会话正在运行" : "恢复该会话（node-pty 网页终端）", disabled: running, onClick: () => onRestore(sess) }, [
							h(Icon, { name: "power", size: 11, className: "dhac_inlineIcon" }),
							h("span", null, "恢复")
						]),
						sess.live === true
							? h("button", { type: "button", className: "dhac_btn dhac_btnSm dhac_btnDanger", title: "关闭该运行中的智能体窗口（尚无历史会话可删）", onClick: () => onLiveClose(sess) }, [
								h(Icon, { name: "x", size: 11, className: "dhac_inlineIcon" }),
								h("span", null, "关闭")
							])
							: h("button", { type: "button", className: "dhac_btn dhac_btnSm dhac_btnDanger", title: "删除该会话记录", onClick: () => onDelete(sess) }, [
								h(Icon, { name: "x", size: 11, className: "dhac_inlineIcon" }),
								h("span", null, "删除")
							])
					])
				]);
			})),
		totalPages > 1 && h("div", { className: "dhac_sessPager" }, [
			h("button", { type: "button", className: "dhac_iconBtn", title: "上一页", disabled: safePage <= 1, onClick: () => setPage(safePage - 1) }, h(Icon, { name: "chevron-left", size: 12 })),
			h("span", { className: "dhac_sessPagerInfo" }, `${safePage}/${totalPages} · 共 ${total} 条`),
			h("button", { type: "button", className: "dhac_iconBtn", title: "下一页", disabled: safePage >= totalPages, onClick: () => setPage(safePage + 1) }, h(Icon, { name: "chevron-right", size: 12 }))
		])
	]);
}

function TerminalDetail({ agent, onBack, onCompact, onNewSession, onCloseAgent, onRestore, onForget }) {
	const signalRef = useRef(null);
	const ghost = agent.running === false;
	return h("div", { className: "dhac_root" }, [
		h("div", { className: "dhac_toolbar" }, [
			h("button", { type: "button", className: "dhac_iconButton", title: "返回列表", onClick: onBack }, h(Icon, { name: "chevron-left", size: 14 })),
			h("span", { className: "dhac_toolbarName", title: `${agent.name} · ${agent.cwd}` }, `${agent.name} (${agent.type})`),
			h("span", { className: "dhac_agentMeta" }, ghost ? "已保存·未运行" : (STATUS_LABEL[agent.status] ?? agent.status)),
			ghost && h("button", { type: "button", className: "dhac_iconButton", title: "重新启动该智能体（恢复会话）", onClick: () => onRestore(agent.id) }, h(Icon, { name: "power", size: 13 })),
			ghost && h("button", { type: "button", className: "dhac_iconButton", title: "删除该保存记录（从 .deepseek/agents.json 移除）", onClick: () => { onForget(agent.id); onBack(); } }, h(Icon, { name: "x", size: 13 })),
			!ghost && COMPACT_SUPPORTED.has(agent.type) && h("button", { type: "button", className: "dhac_iconButton", title: "压缩会话（减少上下文）", onClick: () => onCompact(agent.id) }, h(Icon, { name: "minimize", size: 13 })),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "清空会话历史（在智能体中执行 /clear 或 /new，开始新对话）", onClick: () => onNewSession(agent.id) }, h(Icon, { name: "trash", size: 13 })),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "中断 (Ctrl+C)", onClick: () => signalRef.current?.("SIGINT") }, h(Icon, { name: "stop", size: 13 })),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "关闭智能体", onClick: () => { onCloseAgent(agent.id); onBack(); } }, h(Icon, { name: "x", size: 13 }))
		]),
		ghost
			? h("div", { className: "dhac_terminalDead" }, [
				h("div", null, "该智能体记录保存在本工作区的 .deepseek/agents.json 中，但进程未运行（恢复失败或已关闭）。"),
				h("div", { className: "dhac_terminalDeadHint" }, [
					"点「",
					h(Icon, { name: "power", size: 11, className: "dhac_inlineIcon" }),
					" 恢复」重新启动；点「",
					h(Icon, { name: "x", size: 11, className: "dhac_inlineIcon" }),
					"」删除该记录。"
				])
			])
			: (agent.exited
				? h("div", { className: "dhac_terminalDead" }, [`进程已退出 (code ${agent.exitCode ?? "?"})`])
				: h(AgentTerminal, { agentId: agent.id, signalRef }))
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
	const [detailId, setDetailId] = useState(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [toasts, setToasts] = useState([]);
	const [workspaceCwd, setWorkspaceCwd] = useState(void 0);
	const [savedGhosts, setSavedGhosts] = useState([]);
	const [scanning, setScanning] = useState(false);
	const [sessions, setSessionsState] = useState(getSessions);
	const [sessionsLoading, setSessionsLoading] = useState(false);
	const { rootRef, onDragStart } = useDetailsColumn();
	const sessionId = props.sessionId;
	const sessionCwd = typeof props.useSessions === "function"
		? props.useSessions((s) => (s.current !== void 0 ? s.byId[s.current]?.cwd : void 0))
		: void 0;
	const sessionName = typeof props.useSessions === "function"
		? props.useSessions((s) => (s.current !== void 0 ? s.byId[s.current]?.title : void 0))
		: void 0;
	const workspaceId = typeof props.useWorkspaces === "function"
		? props.useWorkspaces((s) => (sessionId !== void 0 ? s.items?.find((w) => w.sessionIds?.includes(sessionId))?.workspaceId : void 0))
		: void 0;

	const pushToast = useCallback((text, kind) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		setToasts((list) => [...list.slice(-4), { id, text, kind }]);
		setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000);
	}, []);

	// 拉取会话历史（cc-switch 式）：GET /sessions?cwd=。新建/恢复/删除智能体后
	// 立即调用，让「会话历史」列表马上反映最新会话，而不是等 30s 巡检。
	const refreshSessions = useCallback((cwd) => {
		if (typeof cwd !== "string" || cwd === "") {
			setSessionsState([]);
			return;
		}
		setSessionsLoading(true);
		apiGet(`/sessions?cwd=${encodeURIComponent(cwd)}`)
			.then((value) => setSessionsState(Array.isArray(value?.sessions) ? value.sessions : []))
			.catch(() => {})
			.finally(() => setSessionsLoading(false));
	}, []);

	// 重新检测：向服务端扫描本文件夹 .deepseek/agents.json（恢复未运行的
	// 已保存智能体、返回“已保存未运行”的幽灵记录），并拉取本文件夹的智能体列表。
	const reDetect = useCallback((cwd) => {
		refreshSessions(cwd);
		if (typeof cwd === "string" && cwd !== "") {
			setScanning(true);
			apiPost("/agents/scan", { cwd }).then((value) => {
				setAgents(value?.agents ?? []);
				setSavedGhosts(value?.saved ?? []);
				if (Number(value?.restored ?? 0) > 0) pushToast(`重新检测：已恢复 ${value.restored} 个本文件夹的智能体`, "done");
			}).catch(() => {
				apiGet(`/agents?cwd=${encodeURIComponent(cwd)}`).then((v) => setAgents(v?.agents ?? [])).catch(() => {});
			}).finally(() => setScanning(false));
		} else {
			setSavedGhosts([]);
			apiGet("/agents").then((v) => setAgents(v?.agents ?? [])).catch(() => {});
		}
	}, [pushToast, refreshSessions]);

	// 每次切换工作区（会话工作目录变化）→ 重新检测本文件夹的智能体列表：
	// 1) 列表 WS 按 cwd 重新连接（后续只推送本文件夹的智能体）
	// 2) 扫描 .deepseek/agents.json 恢复/列出本文件夹的智能体
	useEffect(() => {
		const cwd = typeof sessionCwd === "string" && sessionCwd !== "" ? sessionCwd : void 0;
		setWorkspaceCwd(cwd);
		setListCwd(cwd);
		setSessionsCwd(cwd);
		reDetect(cwd);
	}, [sessionCwd, reDetect]);

	// 会话历史订阅：按工作目录连接 /ws/sessions，随服务端巡检推送更新。
	useEffect(() => {
		connectSessionsWs();
		const unsub = subscribeSessions((next) => setSessionsState(next));
		return unsub;
	}, []);

	// Status notifications: diff the pushed list and toast meaningful
	// transitions. The diff is reset whenever the workspace scope changes, so
	// switching folders never toasts false "已关闭/已创建" for other folders.
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
						pushToast(`智能体 ${agent.name}（${agent.type}）已创建`, "create");
					} else if (old.status === "working" && agent.status === "idle") {
						pushToast(`智能体 ${agent.name} 已完成任务，回到空闲`, "done");
					} else if (old.status !== "exited" && agent.status === "exited") {
						pushToast(`智能体 ${agent.name} 已退出`, "exit");
					}
					// 简报注入完成（引擎已开始会话）→ 刷新会话历史，让刚创建的会话尽快出现。
					if (old?.briefing === "pending" && (agent.briefing === "sent" || agent.briefing === "done")) briefingDone = true;
				}
				for (const agent of prev) {
					if (!next.some((a) => a.id === agent.id)) pushToast(`智能体 ${agent.name} 已关闭`, "exit");
				}
				if (briefingDone) refreshSessions(listCwd);
			}
			setAgentsState(next);
		});
		return unsub;
	}, [pushToast, refreshSessions]);

	const merged = savedGhosts.length > 0 ? [...agents, ...savedGhosts] : agents;
	const detail = detailId === null ? void 0 : merged.find((a) => a.id === detailId);
	const closeAgent = async (id) => {
		try {
			// graceful: ask the agent to /exit itself before the server escalates
			await apiDelete(`/agents/${encodeURIComponent(id)}?graceful=1`);
		} catch {}
	};
	const newSession = async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/new-session`, {});
		} catch {}
	};
	const compactSession = async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/compact`, {});
		} catch {}
	};
	const restoreSaved = async (id) => {
		try {
			const value = await apiPost(`/agents/${encodeURIComponent(id)}/restore`, { cwd: workspaceCwd, sessionId });
			if (value?.agent) pushToast(`智能体 ${value.agent.name}（${value.agent.type}）已恢复`, "done");
		} catch (err) {
			pushToast(`恢复失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		reDetect(workspaceCwd);
	};
	const forgetSaved = async (id) => {
		try {
			const value = await apiPost(`/agents/${encodeURIComponent(id)}/forget`, { cwd: workspaceCwd, sessionId });
			if (value?.removed) pushToast("已删除该智能体的保存记录", "done");
			else pushToast("没有找到该保存记录", "exit");
		} catch (err) {
			pushToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		reDetect(workspaceCwd);
	};
	// 恢复一条历史会话：走 node-pty 网页终端（resume 命令），恢复后进入「运行中」。
	const restoreSession = async (sess) => {
		try {
			const value = await apiPost("/sessions/restore", { engine: sess.engine, id: sess.id, cwd: workspaceCwd, name: sess.title });
			if (value?.agent) pushToast(`已恢复「${String(sess.title || sess.id).slice(0, 24)}」到 node-pty 网页终端`, "done");
			else pushToast(`未能恢复「${String(sess.title || sess.id).slice(0, 24)}」`, "exit");
		} catch (err) {
			pushToast(`恢复失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		refreshSessions(workspaceCwd);
		reDetect(workspaceCwd);
	};
	const deleteSession = async (sess) => {
		try {
			const value = await apiDelete(`/sessions/${encodeURIComponent(sess.engine)}/${encodeURIComponent(sess.id)}?cwd=${encodeURIComponent(workspaceCwd ?? "")}&sessionId=${encodeURIComponent(sessionId ?? "")}`);
			if (value?.deleted) pushToast("会话已删除", "done");
			else pushToast("没有找到该会话记录", "exit");
		} catch (err) {
			pushToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		refreshSessions(workspaceCwd);
	};
	// 关闭 live 卡片对应的运行中窗口（该窗口还没有落盘的历史会话，删除无意义，
	// 语义是「关掉这个刚开的智能体」）。关完立刻刷新会话历史，live 卡片消失。
	const closeLiveSession = async (sess) => {
		const agentId = sess?.runningAgent?.agentId;
		if (typeof agentId !== "string" || agentId === "") return;
		try {
			await apiDelete(`/agents/${encodeURIComponent(agentId)}?graceful=1`);
			pushToast(`已关闭「${String(sess.title ?? agentId).slice(0, 24)}」的运行窗口`, "done");
		} catch (err) {
			pushToast(`关闭失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		refreshSessions(workspaceCwd);
	};
	const workspaceLabel = workspaceCwd !== void 0
		? (workspaceCwd.split("/").filter(Boolean).pop() || workspaceCwd)
		: "全部工作区";

	return h("div", { ref: rootRef, className: "dhac_root" }, [
		h("div", { className: "dhac_resizeHandle", title: "拖拽调整宽度", onPointerDown: onDragStart }),
		h("div", { className: "dhac_header" }, [
			h("span", { className: "dhac_headerTitle" }, "智能体雷达"),
			h("span", { className: "dhac_count" }, String(merged.length)),
			h("button", { type: "button", className: "dhac_addButton", onClick: () => setDialogOpen(true) }, [
				h(Icon, { name: "plus", size: 13 }),
				h("span", null, "新建")
			])
		]),
		h("div", { className: "dhac_workspace", title: workspaceCwd ?? "未绑定工作区（显示全部智能体）" }, [
			h(Icon, { name: "folder", size: 12, className: "dhac_inlineIcon" }),
			h("span", null, `${workspaceLabel}${scanning ? " · 检测中…" : ""}`)
		]),
		h("div", { className: "dhac_toasts" },
			toasts.map((t) =>
				h("div", { key: t.id, className: `dhac_toast dhac_toast_${t.kind}` }, t.text))),
		h("div", { className: "dhac_body" },
			detail !== void 0
				? h(TerminalDetail, { agent: detail, onBack: () => setDetailId(null), onCompact: compactSession, onNewSession: newSession, onCloseAgent: closeAgent, onRestore: restoreSaved, onForget: forgetSaved })
				: h("div", { className: "dhac_stack" }, [
					h(AgentCards, { agents: merged, scoped: workspaceCwd !== void 0, onOpen: (agent) => setDetailId(agent.id), onCompact: compactSession, onNewSession: newSession, onCloseAgent: closeAgent, onRestore: restoreSaved, onForget: forgetSaved, onRefresh: () => refreshSessions(workspaceCwd) }),
					h(SessionsSection, { sessions, loading: sessionsLoading, onRestore: restoreSession, onDelete: deleteSession, onLiveClose: closeLiveSession, onRefresh: () => refreshSessions(workspaceCwd) })
				])),
		dialogOpen &&
			h(NewAgentDialog, {
				sessionId,
				sessionName,
				workspaceId,
				defaultCwd: sessionCwd,
				onClose: () => setDialogOpen(false),
				onCreated: () => reDetect(workspaceCwd)
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
				sessionsList: (cwd) => apiGet(`/sessions?cwd=${encodeURIComponent(cwd ?? "")}`).then((v) => v?.sessions ?? []),
				sessionsRestore: (engine, id, cwd, name) => apiPost("/sessions/restore", { engine, id, cwd, name }).then((v) => v?.agent),
				sessionsDelete: (engine, id, cwd) => apiDelete(`/sessions/${encodeURIComponent(engine)}/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd ?? "")}`).then((v) => v?.deleted === true),
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
