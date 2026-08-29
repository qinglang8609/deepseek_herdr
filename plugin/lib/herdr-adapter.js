// ============================================================================
// herdr-adapter.js — thin, dependency-free wrapper over the `herdr` CLI.
//
// The herdr CLI talks to the herdr server over a local socket and prints JSON
// envelopes ({ "id": "cli:...", "result": ... }) when stdout is not a TTY.
// This module:
//   • discovers the herdr binary (PATH + common install locations)
//   • probes server availability (`herdr status`)
//   • executes commands with timeouts & classified errors
//   • exposes the workspace / pane / agent surface the Agent Radar needs
//
// Docs: https://herdr.dev/docs/  |  agent SKILL: herdrdev/herdr skills/herdr/SKILL.md
// ============================================================================

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const ABSOLUTE_CANDIDATES = [
	join(HOME, ".local", "bin", "herdr"),
	"/opt/homebrew/bin/herdr",
	"/usr/local/bin/herdr"
];

export const HERDR_ERRORS = {
	NOT_FOUND: "HERDR_NOT_FOUND",
	SERVER_DOWN: "HERDR_SERVER_DOWN",
	AGENT_NOT_READY: "AGENT_NOT_READY",
	AGENT_BLOCKED: "AGENT_BLOCKED",
	AGENT_PROMPT_STALLED: "AGENT_PROMPT_STALLED",
	AGENT_NOT_IDLE: "HERDR_AGENT_NOT_IDLE",
	AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
	TIMEOUT: "TIMEOUT",
	UNKNOWN: "HERDR_ERROR"
};

export class HerdrError extends Error {
	constructor(code, message, detail = null) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
		this.detail = detail;
	}
}

/** Classify an error payload / stderr text into a stable code. */
export function classifyError(text, args = []) {
	const t = String(text ?? "").toLowerCase();
	if (t.includes("agent_not_ready") || t.includes("not ready")) return HERDR_ERRORS.AGENT_NOT_READY;
	if (t.includes("agent_blocked") || /(^|\s)blocked(\s|$)/.test(t)) return HERDR_ERRORS.AGENT_BLOCKED;
	if (t.includes("agent_prompt_stalled") || t.includes("stalled")) return HERDR_ERRORS.AGENT_PROMPT_STALLED;
	if (t.includes("agent_not_idle") || t.includes("not idle")) return HERDR_ERRORS.AGENT_NOT_IDLE;
	if (t.includes("no such agent") || t.includes("agent not found") || t.includes("unknown agent")) return HERDR_ERRORS.AGENT_NOT_FOUND;
	if (t.includes("server down") || t.includes("connection refused") || t.includes("unreachable")) return HERDR_ERRORS.SERVER_DOWN;
	return HERDR_ERRORS.UNKNOWN;
}

export class HerdrAdapter {
	constructor(binary = null) {
		this.binary = binary ?? HerdrAdapter.findBinary();
	}

	/** Locate the herdr binary: scan PATH, then common absolute locations. */
	static findBinary() {
		for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
			try {
				if (existsSync(join(dir, "herdr"))) return join(dir, "herdr");
			} catch {}
		}
		for (const candidate of ABSOLUTE_CANDIDATES) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	/** Probe availability: binary present + server running. Never throws. */
	static async probe(binary = null) {
		const adapter = binary === null ? new HerdrAdapter() : new HerdrAdapter(binary);
		if (adapter.binary === null) {
			return { available: false, version: null, reason: HERDR_ERRORS.NOT_FOUND };
		}
		try {
			const out = await adapter.callRaw(["--version"]);
			const version = (String(out.stdout ?? "").match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? null;
			const status = await adapter.callRaw(["status"]);
			const running = String(status.stdout ?? "").includes("status: running");
			if (!running) {
				return { available: false, version, reason: HERDR_ERRORS.SERVER_DOWN };
			}
			return { available: true, version, reason: null };
		} catch (error) {
			return {
				available: false,
				version: null,
				reason: error instanceof HerdrError ? error.code : String(error?.message ?? error)
			};
		}
	}

	/** Raw execFile; resolves { stdout, stderr, code }; throws only on ENOENT/timeout. */
	callRaw(args, { timeoutMs = 30000 } = {}) {
		return new Promise((resolve, reject) => {
			if (this.binary === null) {
				reject(new HerdrError(HERDR_ERRORS.NOT_FOUND, "herdr binary not found"));
				return;
			}
			execFile(
				this.binary,
				args,
				{
					timeout: timeoutMs,
					maxBuffer: 16 * 1024 * 1024,
					encoding: "utf8",
					env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
				},
				(error, stdout, stderr) => {
					if (error) {
						if (error.killed) {
							reject(new HerdrError(HERDR_ERRORS.TIMEOUT, `herdr ${args.join(" ")} timed out after ${timeoutMs}ms`, { args }));
							return;
						}
						if (error.code === "ENOENT") {
							reject(new HerdrError(HERDR_ERRORS.NOT_FOUND, `herdr binary not found: ${this.binary}`));
							return;
						}
						resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: error.code ?? 1 });
						return;
					}
					resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
				}
			);
		});
	}

	/**
	 * Execute a command and return its `.result` payload.
	 * Classifies JSON error envelopes and non-zero exits.
	 */
	async call(args, { timeoutMs = 30000 } = {}) {
		const { stdout, stderr, code } = await this.callRaw(args, { timeoutMs });
		let parsed = null;
		try {
			parsed = JSON.parse(stdout);
		} catch {}
		if (parsed !== null && typeof parsed === "object") {
			if ("error" in parsed && parsed.error !== null) {
				const detail = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
				throw new HerdrError(classifyError(detail, args), `herdr ${args.join(" ")}: ${detail}`, parsed.error);
			}
			if ("result" in parsed) return parsed.result;
		}
		if (code !== 0) {
			const text = `${stderr}\n${stdout}`.trim();
			throw new HerdrError(classifyError(text, args), `herdr ${args.join(" ")} failed (exit ${code}): ${text || "no output"}`, { code });
		}
		// Plain-text fallback (e.g. --version, status).
		return stdout;
	}

	// ---- workspace ----
	async workspaceList() {
		return this.call(["workspace", "list"]);
	}
	async workspaceCreate(cwd, label) {
		return this.call(["workspace", "create", "--cwd", cwd, "--label", label]);
	}
	async workspaceClose(workspaceId) {
		return this.call(["workspace", "close", workspaceId]);
	}

	// ---- pane ----
	async paneList(workspaceId = null) {
		const args = ["pane", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		return this.call(args);
	}
	async paneSplit(paneId, direction = "right", cwd = null) {
		const args = ["pane", "split"];
		if (paneId) args.push("--pane", paneId);
		args.push("--direction", direction);
		if (cwd) args.push("--cwd", cwd);
		return this.call(args);
	}
	async paneRead(paneId, lines = 120) {
		return this.call(["pane", "read", paneId, "--source", "recent", "--lines", String(lines), "--format", "text"]);
	}
	async paneSendText(paneId, text) {
		return this.call(["pane", "send-text", paneId, String(text)]);
	}
	async paneSendKeys(paneId, ...keys) {
		return this.call(["pane", "send-keys", paneId, ...keys]);
	}
	async paneClose(paneId) {
		return this.call(["pane", "close", paneId]);
	}

	// ---- agent ----
	async agentList() {
		return this.call(["agent", "list"]);
	}
	async agentGet(name) {
		return this.call(["agent", "get", name]);
	}
	async agentStart(name, kind, paneId, { timeoutMs = 60000 } = {}) {
		return this.call(
			["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", String(timeoutMs)],
			{ timeoutMs: timeoutMs + 5000 }
		);
	}
	/**
	 * Read an agent's terminal output. Defaults to `visible` — a PASSIVE read
	 * that never moves the agent's viewport. `recent-unwrapped` with a large
	 * --lines makes herdr scroll the agent's alternate screen to collect pages
	 * (visibly "refreshing" the agent UI), so it is only used on demand.
	 */
	async agentRead(name, lines = 60, source = "visible") {
		return this.call(["agent", "read", name, "--source", source, "--lines", String(lines), "--format", "text"]);
	}
	async agentPrompt(name, text, { wait = false, until = null, timeoutMs = 120000 } = {}) {
		const args = ["agent", "prompt", name, String(text)];
		if (wait) args.push("--wait");
		for (const u of until === null ? [] : Array.isArray(until) ? until : [until]) args.push("--until", u);
		if (wait || until) args.push("--timeout", String(timeoutMs));
		return this.call(args, { timeoutMs: (wait || until) ? timeoutMs + 5000 : 30000 });
	}
	async agentWait(name, { until = null, timeoutMs = 120000 } = {}) {
		const args = ["agent", "wait", name];
		for (const u of until === null ? [] : Array.isArray(until) ? until : [until]) args.push("--until", u);
		args.push("--timeout", String(timeoutMs));
		return this.call(args, { timeoutMs: timeoutMs + 5000 });
	}
	async agentSendKeys(name, ...keys) {
		return this.call(["agent", "send-keys", name, ...keys]);
	}

	// ---- integration ----
	async integrationStatus() {
		return this.call(["integration", "status"]);
	}

	/** Self-check used at plugin boot: server reachable + list endpoints work. */
	async selftest() {
		if (this.binary === null) return { ok: false, reason: HERDR_ERRORS.NOT_FOUND };
		try {
			await this.call(["workspace", "list"]);
			await this.call(["agent", "list"]);
			const probe = await HerdrAdapter.probe(this.binary);
			return { ok: probe.available === true, version: probe.version, reason: probe.reason };
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof HerdrError ? error.code : String(error?.message ?? error)
			};
		}
	}
}
