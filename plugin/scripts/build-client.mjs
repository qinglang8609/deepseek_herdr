// ============================================================================
// Build the single-file client bundle: lib/client.js
//   head.js + panel css injection + app.js + tail.js
//
// Run with the bundled Electron-as-node:
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" scripts/build-client.mjs
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "client");
const out = join(root, "lib", "client.js");

const head = readFileSync(join(src, "head.js"), "utf8");
const panelCss = readFileSync(join(src, "panel.css"), "utf8");
const app = readFileSync(join(src, "app.js"), "utf8");
const tail = readFileSync(join(src, "tail.js"), "utf8");

function cssInjection(tagId, quotedLiteral, varName) {
	return [
		`//#region dsh-agent-commander css: ${tagId}`,
		`const ${varName} = ${quotedLiteral};`,
		`const ${varName}TagId = ${JSON.stringify(tagId)};`,
		`if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(${varName}TagId) + "]") === null) {`,
		`\tconst tag = document.createElement("style");`,
		`\ttag.dataset.plugin = "dsh-agent-commander";`,
		`\ttag.dataset.pluginCss = ${varName}TagId;`,
		`\ttag.textContent = ${varName};`,
		`\tdocument.head.appendChild(tag);`,
		`}`,
		"//#endregion",
		""
	].join("\n");
}

const parts = [
	head,
	"",
	cssInjection("dsh-agent-commander/panel.css", JSON.stringify(panelCss), "panelCss"),
	app,
	"",
	tail
];

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, parts.join("\n"), "utf8");
console.log(`built ${out} (${Buffer.byteLength(parts.join("\n"), "utf8")} bytes)`);
