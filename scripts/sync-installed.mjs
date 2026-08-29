// ============================================================================
// sync-installed.mjs — sync the checkout plugin into the installed DSH copy.
//
// WHY: DSH materializes plugin symlinks into real copies on restart, so a
// symlinked dev loop silently serves a FROZEN old bundle. Run this after any
// build to push lib/, skill/, package.json into the installed profile dir.
//
//   node scripts/sync-installed.mjs            # default profile: web
//   node scripts/sync-installed.mjs --profile <name>
// ============================================================================
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profile = profileIdx !== -1 ? args[profileIdx + 1] : "web";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "plugin");
const DST = join(homedir(), ".dsh", "profiles", profile, "node_modules", "dsh-agent-commander");

if (!existsSync(DST)) {
	console.error(`未找到安装目录：${DST}（先 bash install.sh 安装一次）`);
	process.exit(1);
}

for (const item of ["lib", "skill", "cordis.patch.yml", "package.json", "README.md"]) {
	cpSync(join(SRC, item), join(DST, item), { recursive: true, force: true });
}
console.log(`已同步 ${SRC} → ${DST}`);
console.log("重启 DeepSeek Harness 生效。");
