// ============================================================================
// keystroke.js — 向系统终端注入按键（agent_send / agent_approve 用）。
//
// 原理：osascript + System Events keystroke —— 向当前聚焦的 App（终端）键入
// 文本/回车。需要「辅助功能」（Accessibility）权限：系统设置 → 隐私与安全 →
// 辅助功能 → 勾选 DeepSeek Harness。
//
// 限制：只能发到前台 App；注入前应先把目标终端置前（activate）。
// ============================================================================

import { execFile } from "node:child_process";

const execFileAsync = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
	execFile(cmd, args, { timeout: 8000, ...opts }, (error, stdout, stderr) => {
		if (error) {
			reject(new Error(`${stderr ?? ""}${stdout ?? ""}`.trim() || error.message));
			return;
		}
		resolve(String(stdout ?? "").trim());
	});
});

const osascript = (script) => execFileAsync("/usr/bin/osascript", ["-e", script]);

/** AppleScript 字符串转义。 */
function ashq(s) {
	return '"' + String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 把前台 App 激活为指定终端（Terminal/Ghostty/iTerm 的进程名或 bundle 名）。 */
export function activateApp(appName) {
	return osascript(`tell application ${ashq(appName)} to activate`);
}

/**
 * 键入一段文本（原样发送，不回车）。失败（无辅助功能权限等）抛错。
 */
export async function typeText(text) {
	// keystroke 不支持换行；长文本分块避免单帧过大。
	const chunk = String(text ?? "");
	if (chunk === "") return;
	// System Events keystroke 对换行/特殊键要用 key code；普通文本逐段发。
	const lines = chunk.split("\n");
	for (let i = 0; i < lines.length; i++) {
		await osascript(`tell application "System Events" to keystroke ${ashq(lines[i])}`);
		if (i < lines.length - 1) await pressKey("return");
	}
}

/** 按一个键：return / esc / tab / up / down / left / right。 */
export async function pressKey(key) {
	const mapping = {
		enter: "return",
		return: "return",
		esc: "escape",
		tab: "tab",
		up: "up arrow",
		down: "down arrow",
		left: "left arrow",
		right: "right arrow"
	};
	const k = mapping[key] ?? key;
	await osascript(`tell application "System Events" to key code ${keyCodeOf(k)}`);
}

function keyCodeOf(key) {
	// 常用键码（ANSI 布局）
	const codes = {
		return: 36,
		escape: 53,
		tab: 48,
		"up arrow": 126,
		"down arrow": 125,
		"left arrow": 123,
		"right arrow": 124
	};
	return codes[key] ?? 36;
}

/** 键入文本并回车提交。 */
export async function typeTextAndEnter(text) {
	await typeText(text);
	await pressKey("return");
}
