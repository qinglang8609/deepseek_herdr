// Debug: why does herdr classify the opencode agent as "unknown" and why did
// the briefing prompt fail? Prints raw agent list / get / explain + a live
// agent prompt attempt with the exact error.
import { HerdrAdapter } from "../lib/herdr-adapter.js";
import { HerdrAgentRegistry } from "../lib/herdr-registry.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CWD = "/Users/fanchao/Code/deepseek_herdr";

const adapter = new HerdrAdapter();
const reg = new HerdrAgentRegistry(adapter, { baseCwd: CWD, maxAgents: 2 });

const handle = await reg.create({ type: "opencode", name: "调试", role: "", skills: [], cwd: CWD });
console.log("[created]", JSON.stringify({ id: handle.id, herdrName: handle.herdrName, paneId: handle.paneId }));

await sleep(45000);

console.log("\n[RAW agentList]", JSON.stringify(await adapter.agentList(), null, 1));
console.log("\n[RAW agentGet]", JSON.stringify(await adapter.agentGet(handle.herdrName), null, 1));
try {
	const explain = await adapter.call(["agent", "explain", handle.paneId, "--json"]);
	console.log("\n[explain]", JSON.stringify(explain, null, 1));
} catch (e) {
	console.log("\n[explain ERROR]", e.message);
}

console.log("\n[prompt attempt 1] plain (no wait)");
try {
	const r = await adapter.agentPrompt(handle.herdrName, "回复：hello from test", { wait: false });
	console.log("[prompt ok]", JSON.stringify(r));
} catch (e) {
	console.log("[prompt ERROR]", e.code, e.message.slice(0, 300));
}

await sleep(10000);
console.log("\n[RAW agentList after prompt]", JSON.stringify(await adapter.agentList(), null, 1));

console.log("\n[prompt attempt 2] with --wait");
try {
	const r = await adapter.agentPrompt(handle.herdrName, "回复：hello again", { wait: true, timeoutMs: 30000 });
	console.log("[prompt ok]", JSON.stringify(r));
} catch (e) {
	console.log("[prompt ERROR]", e.code, e.message.slice(0, 300));
}

await reg.close(handle.id, true);
reg.shutdown();
console.log("\nDEBUG DONE");
