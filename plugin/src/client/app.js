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
function subscribeAgents(fn) {
	agentListeners.add(fn);
	fn(agentSnapshot);
	return () => {
		agentListeners.delete(fn);
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
function connectListWs() {
	if (listWs !== null && (listWs.readyState === WebSocket.CONNECTING || listWs.readyState === WebSocket.OPEN)) return;
	let ws;
	const open = () => {
		if (listWs !== null && (listWs.readyState === WebSocket.CONNECTING || listWs.readyState === WebSocket.OPEN)) return;
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
		const resizeObserver = new ResizeObserver(() => {
			try {
				fit.fit();
				sendResize();
				pinToBottom();
			} catch {}
		});
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
	if (signalRef !== void 0) signalRef.current = sendSignal;

	return h("div", { className: "dhac_terminalWrap" }, [
		h("div", { className: "dhac_terminalBanner" }, [
			h("span", null, connected ? "● 已连接" : "○ 连接中…"),
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
	const [skills, setSkills] = useState([]);
	const [cwd, setCwd] = useState(defaultCwd ?? "");
	const [binaries, setBinaries] = useState([]);
	const [availableSkills, setAvailableSkills] = useState([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		apiGet("/binaries").then((value) => setBinaries(value?.binaries ?? [])).catch(() => {});
		apiGet("/skills").then((value) => {
			const list = value?.skills ?? [];
			setAvailableSkills(list);
			setSkills(list.map((s) => s.path));
		}).catch(() => {});
	}, []);

	const toggleSkill = (path) => {
		setSkills((current) => (current.includes(path) ? current.filter((p) => p !== path) : [...current, path]));
	};
	const submit = async () => {
		if (busy) return;
		if (type === "") {
			setError("请选择智能体引擎（claude / opencode / codex）");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const body = await apiPost("/agents", { sessionId, sessionName, workspaceId, type, name, role, skills, cwd });
			onCreated(body.agent);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
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
						["数据库专家", "设计专家", "前端专家", "测试专家", "代码审查专家", "架构师"].map((preset) =>
							h("button", { key: preset, type: "button", className: "dhac_preset", onClick: () => setRole(preset) }, preset))),
					h("textarea", {
						className: "dhac_textarea",
						value: role,
						placeholder: "例：你负责数据库设计与 SQL 优化，精通 PostgreSQL；独立完成表结构评审与慢查询分析。",
						onChange: (e) => setRole(e.target.value)
					})
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "挂载技能（该智能体开工前必读）"),
					availableSkills.length === 0
						? h("div", { className: "dhac_hint" }, "未在 ~/.agents/skills 发现技能")
						: h("div", { className: "dhac_skills" },
							availableSkills.map((s) =>
								h("label", { key: s.name, className: `dhac_skill${skills.includes(s.path) ? " dhac_skillSelected" : ""}` }, [
									h("input", {
										type: "checkbox",
										checked: skills.includes(s.path),
										onChange: () => toggleSkill(s.path)
									}),
									s.name
								])))
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
			scrollback: 2000,
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
		const connect = () => {
			if (closed) return;
			ws = new WebSocket(wsUrl(`/agent-commander/ws/terminal?id=${encodeURIComponent(agentId)}`));
			ws.onopen = () => {
				retry = 0;
				sendResize();
			};
			ws.onmessage = (e) => {
				const write = (text) => {
					term.write(text, pinToBottom);
				};
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
		const resizeObserver = new ResizeObserver(() => {
			try {
				fit.fit();
				sendResize();
				pinToBottom();
			} catch {}
		});
		resizeObserver.observe(container);
		return () => {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			if (pinTimer !== null) clearTimeout(pinTimer);
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
function AgentCards({ agents, scoped, onOpen, onCompact, onNewSession, onCloseAgent, onRestore, onForget }) {
	if (agents.length === 0) {
		return h("div", { className: "dhac_empty" }, [
			h("div", null, scoped ? "本文件夹还没有智能体" : "还没有智能体"),
			h("div", { className: "dhac_emptyHint" }, "点击右上角「＋ 新建」打开 claude / opencode / codex，或让 DeepSeek 用 agent_open 工具创建"),
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
						}, "⏻"),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "删除该保存记录（从 .deepseek/agents.json 移除）",
							onClick: (e) => {
								e.stopPropagation();
								onForget(agent.id);
							}
						}, "✕")
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
						}, "🗜"),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "清空会话历史",
							onClick: (e) => {
								e.stopPropagation();
								onNewSession(agent.id);
							}
						}, "↺"),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "关闭智能体",
							onClick: (e) => {
								e.stopPropagation();
								onCloseAgent(agent.id);
							}
						}, "✕")
					])
			]),
			agent.role !== "" && h("div", { className: "dhac_agentRole", title: agent.role }, agent.role),
			h("div", { className: "dhac_agentMeta", title: `${agent.cwd} · 会话 ${agent.sessionName ?? agent.sessionId ?? "-"}` },
				`#${agent.pid ?? "?"}${agent.sessionName ? ` · ${agent.sessionName}` : ""}${agent.workspaceId ? ` · ws:${agent.workspaceId}` : ""}${agent.restored ? " · 已恢复" : ""}`),
			ghost
				? h("div", { className: "dhac_cardExited" }, `未运行（恢复失败或已关闭）— ⏻ 恢复 / ✕ 删除记录`)
				: (agent.exited
					? h("div", { className: "dhac_cardExited" }, `进程已退出 (code ${agent.exitCode ?? "?"}) — 点击重新创建`)
					: h("div", { className: "dhac_miniTermWrap" }, h(MiniTerminal, { agentId: agent.id })))
		]);
	}));
}

function TerminalDetail({ agent, onBack, onCompact, onNewSession, onCloseAgent, onRestore, onForget }) {
	const signalRef = useRef(null);
	const ghost = agent.running === false;
	return h("div", { className: "dhac_root" }, [
		h("div", { className: "dhac_toolbar" }, [
			h("button", { type: "button", className: "dhac_iconButton", title: "返回列表", onClick: onBack }, "‹"),
			h("span", { className: "dhac_toolbarName", title: `${agent.name} · ${agent.cwd}` }, `${agent.name} (${agent.type})`),
			h("span", { className: "dhac_agentMeta" }, ghost ? "已保存·未运行" : (STATUS_LABEL[agent.status] ?? agent.status)),
			ghost && h("button", { type: "button", className: "dhac_iconButton", title: "重新启动该智能体（恢复会话）", onClick: () => onRestore(agent.id) }, "⏻"),
			ghost && h("button", { type: "button", className: "dhac_iconButton", title: "删除该保存记录（从 .deepseek/agents.json 移除）", onClick: () => { onForget(agent.id); onBack(); } }, "✕"),
			!ghost && COMPACT_SUPPORTED.has(agent.type) && h("button", { type: "button", className: "dhac_iconButton", title: "压缩会话（减少上下文）", onClick: () => onCompact(agent.id) }, "🗜"),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "清空会话历史", onClick: () => onNewSession(agent.id) }, "↺"),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "中断 (Ctrl+C)", onClick: () => signalRef.current?.("SIGINT") }, "⏹"),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "关闭智能体", onClick: () => { onCloseAgent(agent.id); onBack(); } }, "✕")
		]),
		ghost
			? h("div", { className: "dhac_terminalDead" }, [
				h("div", null, "该智能体记录保存在本工作区的 .deepseek/agents.json 中，但进程未运行（恢复失败或已关闭）。"),
				h("div", { className: "dhac_terminalDeadHint" }, "点「⏻ 恢复」重新启动；点「✕」删除该记录。")
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

	// 重新检测：向服务端扫描本文件夹 .deepseek/agents.json（恢复未运行的
	// 已保存智能体、返回“已保存未运行”的幽灵记录），并拉取本文件夹的智能体列表。
	const reDetect = useCallback((cwd) => {
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
	}, [pushToast]);

	// 每次切换工作区（会话工作目录变化）→ 重新检测本文件夹的智能体列表：
	// 1) 列表 WS 按 cwd 重新连接（后续只推送本文件夹的智能体）
	// 2) 扫描 .deepseek/agents.json 恢复/列出本文件夹的智能体
	useEffect(() => {
		const cwd = typeof sessionCwd === "string" && sessionCwd !== "" ? sessionCwd : void 0;
		setWorkspaceCwd(cwd);
		setListCwd(cwd);
		reDetect(cwd);
	}, [sessionCwd, reDetect]);

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
				for (const agent of next) {
					const old = byId.get(agent.id);
					if (old === void 0) {
						pushToast(`智能体 ${agent.name}（${agent.type}）已创建`, "create");
					} else if (old.status === "working" && agent.status === "idle") {
						pushToast(`智能体 ${agent.name} 已完成任务，回到空闲`, "done");
					} else if (old.status !== "exited" && agent.status === "exited") {
						pushToast(`智能体 ${agent.name} 已退出`, "exit");
					}
				}
				for (const agent of prev) {
					if (!next.some((a) => a.id === agent.id)) pushToast(`智能体 ${agent.name} 已关闭`, "exit");
				}
			}
			setAgentsState(next);
		});
		return unsub;
	}, [pushToast]);

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
	const workspaceLabel = workspaceCwd !== void 0
		? (workspaceCwd.split("/").filter(Boolean).pop() || workspaceCwd)
		: "全部工作区";

	return h("div", { ref: rootRef, className: "dhac_root" }, [
		h("div", { className: "dhac_resizeHandle", title: "拖拽调整宽度", onPointerDown: onDragStart }),
		h("div", { className: "dhac_header" }, [
			h("span", { className: "dhac_headerTitle" }, "智能体雷达"),
			h("span", { className: "dhac_count" }, String(merged.length)),
			h("button", { type: "button", className: "dhac_iconButton", title: "重新检测本文件夹的智能体列表", onClick: () => reDetect(workspaceCwd), disabled: scanning }, scanning ? "…" : "↻"),
			h("button", { type: "button", className: "dhac_addButton", onClick: () => setDialogOpen(true) }, "＋ 新建")
		]),
		h("div", { className: "dhac_workspace", title: workspaceCwd ?? "未绑定工作区（显示全部智能体）" },
			`📁 ${workspaceLabel}${scanning ? " · 检测中…" : ""}`),
		h("div", { className: "dhac_toasts" },
			toasts.map((t) =>
				h("div", { key: t.id, className: `dhac_toast dhac_toast_${t.kind}` }, t.text))),
		h("div", { className: "dhac_body" },
			detail !== void 0
				? h(TerminalDetail, { agent: detail, onBack: () => setDetailId(null), onCompact: compactSession, onNewSession: newSession, onCloseAgent: closeAgent, onRestore: restoreSaved, onForget: forgetSaved })
				: h(AgentCards, { agents: merged, scoped: workspaceCwd !== void 0, onOpen: (agent) => setDetailId(agent.id), onCompact: compactSession, onNewSession: newSession, onCloseAgent: closeAgent, onRestore: restoreSaved, onForget: forgetSaved })),
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
			icon.textContent = "🤖";
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
