// ============================================================================
// session-scanner.js — 四引擎会话历史扫描 / 删除（cc-switch 式会话管理）。
//
// 数据源：
//   claude    ~/.claude/projects/<cwd-slug>/*.jsonl      （id=文件名，标题=首个 user 文本）
//   opencode  ~/.local/share/opencode/opencode.db        （SQLite session 表）
//   codex     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（session_meta 里 cwd/session_id）
//   codebuddy ~/.codebuddy/projects/<cwd-slug>/*.jsonl    （与 claude 同构，待验证）
//
// 返回统一结构：{ engine, id, title, time, tokens, cost, cwd }
// 恢复（restore）由 terminal-registry.restoreSession 负责；本模块只做扫描+删除。
// 为避免大 jsonl 反复全量读：按 (mtime,size) 缓存统计结果。
// ============================================================================

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
const CODEBUDDY_PROJECTS = join(HOME, ".codebuddy", "projects");
const OPENCODE_DB = join(HOME, ".local", "share", "opencode", "opencode.db");
const CODEX_SESSIONS = join(HOME, ".codex", "sessions");

const execFileAsync = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
	execFile(cmd, args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024, ...opts }, (error, stdout) => {
		if (error) {
			reject(error);
			return;
		}
		resolve(String(stdout ?? "").trim());
	});
});

/** cwd → claude/codebuddy 项目目录 slug（非字母数字 → '-'）。 */
export function slugOf(cwd) {
	return String(cwd ?? "").replace(/[^a-zA-Z0-9]+/g, "-");
}

export class SessionScanner {
	constructor() {
		this._cache = new Map(); // `${path}:${mtime}:${size}` → parsed stats
		this._cacheMs = 15000;
	}

	/** 扫描一个工作目录的全部会话（按时间倒序）。 */
	async list(cwd) {
		const all = [];
		for (const fn of ["listClaude", "listOpencode", "listCodex", "listCodebuddy"]) {
			try {
				const items = await this[fn](cwd);
				all.push(...items);
			} catch {}
		}
		return all.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
	}

	// ------------------------------------------------------------ claude
	async listClaude(cwd) {
		const dir = join(CLAUDE_PROJECTS, slugOf(cwd));
		if (!existsSync(dir)) return [];
		const out = [];
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
			const full = join(dir, f);
			const st = statSync(full);
			const info = this._cached(full, st);
			const id = f.replace(/\.jsonl$/, "");
			out.push({
				engine: "claude",
				id,
				title: info.title ?? `会话 ${id.slice(0, 8)}`,
				time: st.mtimeMs,
				tokens: info.tokens ?? 0,
				cost: info.cost ?? null,
				cwd
			});
		}
		return out;
	}

	// ---------------------------------------------------------- opencode
	async listOpencode(cwd) {
		if (!existsSync(OPENCODE_DB)) return [];
		const q = (sql) => execFileAsync("/usr/bin/sqlite3", [OPENCODE_DB, sql], { timeout: 8000 });
		const esc = String(cwd).replace(/'/g, "''");
		const rows = await q(
			`SELECT id, title, cost, tokens_input + tokens_output + tokens_reasoning, time_created FROM session ` +
			`WHERE directory = '${esc}' AND time_archived IS NULL ORDER BY time_created DESC LIMIT 200`
		);
		if (rows === "") return [];
		return rows.split("\n").filter(Boolean).map((line) => {
			const [id, title, cost, tokens, time] = line.split("|");
			return {
				engine: "opencode",
				id: id ?? "",
				title: (title ?? "新建会话").slice(0, 60),
				time: Number(time ?? 0),
				tokens: Number(tokens ?? 0) || 0,
				cost: Number(cost) > 0 ? Number(cost) : null,
				cwd
			};
		});
	}

	// ------------------------------------------------------------- codex
	async listCodex(cwd) {
		if (!existsSync(CODEX_SESSIONS)) return [];
		const out = [];
		const scan = (dir) => {
			let entries = [];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const p = join(dir, e.name);
				if (e.isDirectory()) {
					scan(p);
				} else if (e.name.endsWith(".jsonl")) {
					out.push(p);
				}
			}
		};
		scan(CODEX_SESSIONS);
		const result = [];
		for (const p of out) {
			try {
				const st = statSync(p);
				const first = readFileSync(p, "utf8").split("\n").find((l) => l.includes("session_meta"));
				if (!first) continue;
				const meta = JSON.parse(first).payload ?? {};
				if (meta.cwd !== cwd) continue;
				result.push({
					engine: "codex",
					id: meta.session_id ?? p.split("/").pop().replace(/\.jsonl$/, ""),
					title: (meta.title ?? "Codex 会话").slice(0, 60),
					time: new Date(meta.timestamp ?? st.mtime).getTime() || st.mtimeMs,
					tokens: 0, // codex jsonl usage 逐事件，代价高；v1 先不统计
					cost: null,
					cwd
				});
			} catch {}
		}
		return result;
	}

	// --------------------------------------------------------- codebuddy
	async listCodebuddy(cwd) {
		const dir = join(CODEBUDDY_PROJECTS, slugOf(cwd));
		if (!existsSync(dir)) return [];
		const out = [];
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
			const full = join(dir, f);
			const st = statSync(full);
			const info = this._cached(full, st);
			const id = f.replace(/\.jsonl$/, "");
			out.push({
				engine: "codebuddy",
				id,
				title: info.title ?? `会话 ${id.slice(0, 8)}`,
				time: st.mtimeMs,
				tokens: info.tokens ?? 0,
				cost: info.cost ?? null,
				cwd
			});
		}
		return out;
	}

	// ------------------------------------------------------------ delete
	async deleteSession(engine, id, cwd) {
		if (engine === "claude") {
			const p = join(CLAUDE_PROJECTS, slugOf(cwd), `${id}.jsonl`);
			if (existsSync(p)) unlinkSync(p);
			return;
		}
		if (engine === "codebuddy") {
			const p = join(CODEBUDDY_PROJECTS, slugOf(cwd), `${id}.jsonl`);
			if (existsSync(p)) unlinkSync(p);
			return;
		}
		if (engine === "opencode") {
			// 优先用 opencode 自带命令，失败回退 sqlite
			try {
				await execFileAsync(join(HOME, ".opencode", "bin", "opencode"), ["session", "delete", "--id", id], { timeout: 10000 });
				return;
			} catch {}
			// 递归找 session_id 匹配的 codex 文件（含归档）→ 删文件
			await this._deleteFromDb("opencode", id);
			return;
		}
		if (engine === "codex") {
			try {
				await execFileAsync(join(HOME, ".local", "bin", "codex"), ["delete", id], { timeout: 10000 });
				return;
			} catch {}
			// 兜底：删匹配文件
			this._walkDelete(CODEX_SESSIONS, (meta) => meta.session_id === id);
			return;
		}
		throw new Error(`未知引擎 ${engine}`);
	}

	async _deleteFromDb(engine, id) {
		if (!existsSync(OPENCODE_DB)) return;
		await execFileAsync("/usr/bin/sqlite3", [OPENCODE_DB, `DELETE FROM session WHERE id = '${String(id).replace(/'/g, "''")}';`], { timeout: 8000 }).catch(() => {});
	}

	_walkDelete(root, match) {
		if (!existsSync(root)) return;
		const scan = (dir) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isDirectory()) {
					scan(p);
				} else if (e.name.endsWith(".jsonl")) {
					try {
						const first = readFileSync(p, "utf8").split("\n").find((l) => l.includes("session_meta"));
						const meta = first ? JSON.parse(first).payload ?? {} : {};
						if (match(meta)) unlinkSync(p);
					} catch {}
				}
			}
		};
		scan(root);
	}

	// jsonl 统计缓存：按 (mtime,size) 命中，避免大文件反复全量读。
	_cached(path, st) {
		const key = `${path}:${st.mtimeMs}:${st.size}`;
		const hit = this._cache.get(key);
		if (hit !== void 0) return hit;
		const info = this._parseJsonl(path);
		this._cache.set(key, info);
		if (this._cache.size > 200) {
			for (const k of this._cache.keys()) {
				this._cache.delete(k);
				if (this._cache.size <= 100) break;
			}
		}
		return info;
	}

	/** 解析 claude/codebuddy 风格 jsonl：标题（首个 user 文本）+ token 汇总。 */
	_parseJsonl(path) {
		const info = { title: null, tokens: 0, cost: null };
		let tIn = 0;
		let tOut = 0;
		let foundTitle = false;
		try {
			const lines = readFileSync(path, "utf8").split("\n");
			const limit = Math.min(lines.length, 4000); // 最多读 4000 行控制开销
			for (let i = 0; i < limit; i++) {
				const line = lines[i];
				if (line === "") continue;
				let d;
				try {
					d = JSON.parse(line);
				} catch {
					continue;
				}
				if (!foundTitle && d?.type === "user" && d.message?.tool_use_id === void 0) {
					const c = d.message?.content;
					const text = Array.isArray(c)
						? c.filter((p) => typeof p === "string" || p?.type === "text").map((p) => (typeof p === "string" ? p : p.text ?? "")).join(" ").trim()
						: typeof c === "string" ? c.trim() : "";
					if (text !== "") {
						info.title = text.slice(0, 60);
						foundTitle = true;
					}
				}
				if (d?.type === "assistant") {
					const u = d.message?.usage;
					if (u && typeof u === "object") {
						tIn += u.input_tokens ?? 0;
						tOut += u.output_tokens ?? 0;
					}
				}
			}
		} catch {}
		info.tokens = tIn + tOut;
		info.cost = null; // 不做成本估算（claude 计费复杂）
		return info;
	}
}
