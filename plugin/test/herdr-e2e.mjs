// ============================================================================
// herdr-e2e.mjs — end-to-end smoke test for the herdr agent host.
//
//   PATH="$HOME/.local/bin:$PATH" node test/herdr-e2e.mjs
//
// Requires a running herdr server. Exercises the FULL loop against a real
// opencode agent in the herdr server:
//   workspace ensure → pane split → agent start → briefing inject →
//   list → read → send task → read result → close.
// ============================================================================

import { HerdrAdapter } from "../lib/herdr-adapter.js";
import { HerdrAgentRegistry } from "../lib/herdr-registry.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 测试专用目录：若在 herdr 里看到名为 dsh-e2e-test 的空间，是测试创建且会自动清理。
const CWD = "/tmp/dsh-e2e-test";
import { mkdirSync, rmSync } from "node:fs";
mkdirSync(CWD, { recursive: true });

const adapter = new HerdrAdapter();
const probe = await HerdrAdapter.probe(adapter.binary);
console.log("[probe]", JSON.stringify(probe));
if (!probe.available) {
	console.error("herdr 不可用，中止");
	process.exit(1);
}

const reg = new HerdrAgentRegistry(adapter, { baseCwd: CWD, maxAgents: 4 });
console.log("[list before]", JSON.stringify(reg.list().map((m) => `${m.id}:${m.status}`)));

const handle = await reg.create({
	type: "opencode",
	name: "冒烟测试",
	role: "你是端到端测试智能体，用于验证 herdr 集成链路。",
	skills: [],
	cwd: CWD
});
console.log("[created]", JSON.stringify({
	id: handle.id,
	herdrName: handle.herdrName,
	paneId: handle.paneId,
	workspaceId: handle.workspaceId,
	status: handle.status
}));

// Boot window: opencode 启动 + 简报注入（异步）可能需要较长时间。
for (let i = 0; i < 20; i++) {
	await sleep(5000);
	const metas = reg.list();
	const me = metas.find((m) => m.id === handle.id);
	console.log(`[t+${(i + 1) * 5}s] status=${me?.status} briefing=${me?.briefing} exited=${me?.exited}`);
	if (me?.status === "blocked") {
		console.log("[approve] blocked → 发送确认");
		await reg.approve(handle.id, "1");
	}
	if (me?.exited) {
		console.error("[FAIL] agent 意外退出");
		process.exit(1);
	}
	if (me?.status === "idle" || me?.status === "working") break;
}

const r1 = await reg.read(handle.id, 4000);
console.log("[read head]", JSON.stringify(r1.output.slice(0, 300)));

console.log("[send] 派发测试任务…");
await reg.send(handle.id, "请只回复一行：收到测试指令，当前目录是 <pwd>。", true);
await sleep(20000);
const r2 = await reg.read(handle.id, 6000);
console.log("[read after task]", JSON.stringify(r2.output.slice(-600)));

console.log("[close] 优雅退出…");
await reg.close(handle.id, true);
console.log("[list after]", JSON.stringify(reg.list().map((m) => `${m.id}:${m.status}`)));

reg.shutdown();
try {
	rmSync(CWD, { recursive: true, force: true });
} catch {}
console.log("E2E DONE ✅");
