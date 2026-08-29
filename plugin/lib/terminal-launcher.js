// ============================================================================
// terminal-launcher.js — 拉起系统终端窗口运行智能体命令。
//
// 目标：不在浏览器里渲染终端，而是调用 macOS 系统终端软件打开真实窗口。
// 统一走 LaunchServices（`open -a <App> <脚本>`），避免 Apple Events
// 自动化权限（osascript do script 需要 TCC Automation，沙箱/受限环境会
// 直接 -10004）：
//   • Terminal.app — 写临时 .command 脚本 + `open -a Terminal <script>`
//   • Ghostty      — `open -a Ghostty --args -e bash -lc "<cmd>"`
//   • iTerm2       — `open -a iTerm <script>`（与 Terminal 同机制）
//
// PID 捕获：启动命令模板为
//   cd <cwd> && echo $$ > <pidfile> && exec <engine> <args>
// `$$` 是 shell PID，`exec` 用引擎进程替换 shell → pidfile 里就是引擎 PID。
//
// 关闭窗口：`open` 方式拿不到窗口引用（无 Apple Events），关闭 = 杀进程 +
// 提示用户；Terminal 窗口在引擎退出后由脚本留痕提示。
// ============================================================================

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

const GHOSTTY_BIN = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
const ITERM_BIN = "/Applications/iTerm.app/Contents/MacOS/iTerm2";

export const TERMINAL_APPS = {
	terminal: { label: "Terminal.app", detect: () => true },
	ghostty: { label: "Ghostty", detect: () => existsSync(GHOSTTY_BIN) },
	iterm2: { label: "iTerm2", detect: () => existsSync(ITERM_BIN) }
};

export const TERMINAL_APP_IDS = Object.keys(TERMINAL_APPS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POSIX shell 单引号转义。 */
export function shq(s) {
	return "'" + String(s ?? "").replace(/'/g, "'\\''") + "'";
}

const execFileAsync = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
	execFile(cmd, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
		if (error) {
			const detail = `${stderr ?? ""}${stdout ?? ""}`.trim();
			reject(new Error(`launch ${cmd} ${args.join(" ")}: ${error.message} ${detail}`.trim()));
			return;
		}
		resolve(String(stdout ?? "").trim());
	});
});

export class TerminalLauncher {
	/**
	 * @param {string} app "auto" | "terminal" | "ghostty" | "iterm2"
	 */
	constructor(app = "auto") {
		this.app = app;
	}

	resolveApp() {
		if (this.app !== "auto") return this.app;
		for (const id of ["ghostty", "terminal"]) {
			if (TERMINAL_APPS[id].detect()) return id;
		}
		return "terminal";
	}

	get label() {
		return TERMINAL_APPS[this.resolveApp()]?.label ?? this.resolveApp();
	}

	/** 组装终端内执行的 shell 命令（带 pidfile；exec 后 shell 被替换，无后续命令）。 */
	buildShellCommand({ cwd, command, pidfile }) {
		const parts = [`cd ${shq(cwd ?? homedir())}`];
		if (pidfile) parts.push(`echo $$ > ${shq(pidfile)}`);
		parts.push(`exec ${command}`);
		return parts.join(" && ");
	}

	/**
	 * 打开系统终端窗口执行命令。
	 * @returns {Promise<{ app: string, scriptPath?: string }>}
	 */
	async launch({ cwd, command, pidfile }) {
		const app = this.resolveApp();
		const shellCmd = this.buildShellCommand({ cwd, command, pidfile });
		if (app === "ghostty") return this.launchGhostty(shellCmd);
		if (app === "iterm2") return this.launchIterm(shellCmd);
		return this.launchTerminal(shellCmd);
	}

	/** 写临时 .command 脚本并交给指定 App 执行（LaunchServices，免自动化权限）。 */
	launchViaScript(appName, shellCmd) {
		const dir = mkdtempSync(join(tmpdir(), "dsh-term-"));
		const scriptPath = join(dir, "run.command");
		writeFileSync(scriptPath, `#!/bin/bash\n${shellCmd}\n`, { mode: 0o755 });
		// 计划删除：窗口跑完再删；这里先保留（引擎可能还要读）
		return execFileAsync("/usr/bin/open", ["-a", appName, scriptPath]).then(() => ({ app: appName.toLowerCase().replace(".app", ""), scriptPath }));
	}

	/** Terminal.app：open -a Terminal <script>.command。 */
	async launchTerminal(shellCmd) {
		return this.launchViaScript("Terminal", shellCmd);
	}

	/** iTerm2：open -a iTerm <script>.command。 */
	async launchIterm(shellCmd) {
		if (!existsSync(ITERM_BIN)) throw new Error("iTerm2 未安装（/Applications/iTerm.app）");
		return this.launchViaScript("iTerm", shellCmd);
	}

	/** Ghostty：open -a Ghostty --args -e bash -lc "cmd"（或 ghostty CLI 兜底）。 */
	async launchGhostty(shellCmd) {
		if (!existsSync(GHOSTTY_BIN)) throw new Error("Ghostty 未安装（/Applications/Ghostty.app）");
		try {
			await execFileAsync("/usr/bin/open", ["-a", "Ghostty", "--args", "-e", "bash", "-lc", shellCmd]);
			return { app: "ghostty", scriptPath: null };
		} catch {
			await execFileAsync(GHOSTTY_BIN, ["-e", "bash", "-lc", shellCmd]);
			return { app: "ghostty", scriptPath: null };
		}
	}

	/** 探测所有可用终端软件（用于前端选择/显示）。 */
	static detectAll() {
		return Object.entries(TERMINAL_APPS).map(([id, t]) => ({ id, label: t.label, available: t.detect() }));
	}
}

// 等待 pidfile 出现（引擎进程启动），最多 waitMs。
export async function waitForPidfile(pidfile, waitMs = 20000) {
	const { readFileSync } = await import("node:fs");
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		try {
			const pid = Number((readFileSync(pidfile, "utf8") || "").trim());
			if (Number.isFinite(pid) && pid > 0) return pid;
		} catch {}
		await sleep(500);
	}
	return null;
}
