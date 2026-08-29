// ============================================================================
// process-monitor.js — 进程存活监控。
//
// 运行中的智能体 = 系统终端窗口里的引擎进程。注册表持有 { pid, pidfile }，
// 这里提供：kill -0 存活探测、pgrep 兜底、SIGINT/SIGTERM 发送。
// 轮询由注册表驱动（2s）；终端被用户关掉 → 进程消失 → 卡片变灰(exited)。
// ============================================================================

import { execFile } from "node:child_process";

const execFileAsync = (cmd, args, opts = {}) => new Promise((resolve) => {
	execFile(cmd, args, { timeout: 3000, ...opts }, (error, stdout) => {
		resolve({ ok: !error, out: String(stdout ?? "").trim() });
	});
});

/** 进程是否存活：kill(pid, 0)（ESRCH=不存在）。 */
export function isAlive(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM"; // 存在但无权限
	}
}

/** pgrep -f pattern，返回第一个 pid（兜底：pidfile 丢失时按命令行找）。 */
export async function findPidByPattern(pattern) {
	const { ok, out } = await execFileAsync("/usr/bin/pgrep", ["-f", pattern]);
	if (!ok) return null;
	const pid = Number(out.split("\n")[0]);
	return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** 发送信号。signal: SIGINT / SIGTERM / SIGKILL。 */
export function sendSignal(pid, signal = "SIGINT") {
	if (!isAlive(pid)) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}
