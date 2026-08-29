// ============================================================================
// release.mjs — one-shot plugin release flow.
//
//   node scripts/release.mjs [patch|minor|major|X.Y.Z] [--no-commit]
//
// Steps:
//   1. sanity: git branch = main (or --allow-branch), working tree clean
//   2. build the client bundle (Electron-as-node; falls back to PATH node)
//   3. bump version in plugin/package.json + root package.json
//   4. pnpm pack the plugin into dist/ (gitignored) — the installable tarball
//   5. git add + commit "release: vX.Y.Z" + tag vX.Y.Z (skip with --no-commit)
//   6. print the publish checklist (push remotes, dsh plugin add github:…)
//
// Prereqs: node >= 20, pnpm on PATH (falls back to npm pack).
// ============================================================================
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugin");
const DIST = join(ROOT, "dist");
const HARNESS = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";

const args = process.argv.slice(2);
const bumpArg = args.find((a) => !a.startsWith("--")) ?? "patch";
const noCommit = args.includes("--no-commit");

function run(cmd, argsList, opts = {}) {
	console.log(`$ ${cmd} ${argsList.join(" ")}`);
	const out = execFileSync(cmd, argsList, { encoding: "utf8", stdio: "pipe", ...opts });
	if (!opts.silent) process.stdout.write(out);
	return out;
}

function readJson(p) {
	return JSON.parse(readFileSync(p, "utf8"));
}
function writeJson(p, value) {
	writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nextVersion(current, bump) {
	const [major, minor, patch] = current.split(".").map((n) => Number(n) || 0);
	if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

// ---- 1. sanity ------------------------------------------------------------
try {
	const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { silent: true }).trim();
	if (branch !== "main" && !args.includes("--allow-branch")) {
		console.error(`当前分支是 ${branch}，发布请在 main 分支执行（或加 --allow-branch）`);
		process.exit(1);
	}
} catch {
	console.error("不在 git 仓库中");
	process.exit(1);
}
if (!noCommit) {
	const dirty = run("git", ["status", "--porcelain"], { silent: true }).trim();
	if (dirty !== "") {
		console.error("工作区有未提交改动，先提交或加 --no-commit：\n" + dirty);
		process.exit(1);
	}
}

// ---- 2. build client ------------------------------------------------------
console.log("\n[1/5] 构建 client bundle…");
const buildCmd = existsSync(HARNESS)
	? { cmd: HARNESS, args: [join(PLUGIN, "scripts", "build-client.mjs")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
	: { cmd: "node", args: [join(PLUGIN, "scripts", "build-client.mjs")], env: process.env };
try {
	run(buildCmd.cmd, buildCmd.args, { env: buildCmd.env });
} catch {
	console.error("client 构建失败");
	process.exit(1);
}

// ---- 3. bump version ------------------------------------------------------
const pluginPkgPath = join(PLUGIN, "package.json");
const rootPkgPath = join(ROOT, "package.json");
const pluginPkg = readJson(pluginPkgPath);
const rootPkg = readJson(rootPkgPath);
const version = nextVersion(pluginPkg.version, bumpArg);
console.log(`\n[2/5] 版本 ${pluginPkg.version} → ${version}`);
pluginPkg.version = version;
rootPkg.version = version;
writeJson(pluginPkgPath, pluginPkg);
writeJson(rootPkgPath, rootPkg);

// ---- 4. pack tarball ------------------------------------------------------
console.log("\n[3/5] 打包 tarball 到 dist/…");
mkdirSync(DIST, { recursive: true });
try {
	run("sh", ["-c", `rm -f ${join(DIST, "dsh-agent-commander-*.tgz")}`], { silent: true });
} catch {}
const packOut = (() => {
	// npm 的全局缓存（~/.npm/_cacache）可能有 root 属主文件导致 EPERM，
	// 指定工作区内的临时缓存目录绕开。
	const cacheDir = join(DIST, ".npm-cache");
	try {
		return run("pnpm", ["pack", "--pack-destination", DIST], { cwd: PLUGIN, silent: false });
	} catch {
		// pnpm 可能是 corepack 壳（沙箱/离线环境下会下载失败）→ 回退 npm pack
		console.warn("pnpm pack 失败，回退 npm pack");
		return run("npm", ["pack", "--pack-destination", DIST, "--cache", cacheDir], { cwd: PLUGIN, silent: false });
	}
})();
// pnpm pack prints the tarball filename on the last line.
const tarball = packOut.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? `dsh-agent-commander-${version}.tgz`;
const tarballPath = join(DIST, tarball);
if (!existsSync(tarballPath)) {
	console.error(`打包产物未找到：${tarballPath}`);
	process.exit(1);
}
console.log(`\n打包完成：${tarballPath}`);
try {
	rmSync(join(DIST, ".npm-cache"), { recursive: true, force: true });
} catch {}

// ---- 5. commit + tag ------------------------------------------------------
if (noCommit) {
	console.log("\n[4/5] --no-commit：跳过提交与打 tag");
} else {
	console.log("\n[4/5] 提交并打 tag…");
	run("git", ["add", "plugin/package.json", "package.json", "plugin/lib/client.js"]);
	run("git", ["commit", "-m", `release: v${version}`]);
	run("git", ["tag", `v${version}`]);
}

// ---- 6. checklist ---------------------------------------------------------
console.log("\n[5/5] 发布清单：");
console.log(`  git push origin main && git push origin v${version}`);
console.log(`  git push deepseek_herdr main && git push deepseek_herdr v${version}  # 或其它 remote`);
console.log(`  dsh plugin add github:qinglang8609/deepseek_herdr#v${version}`);
console.log(`  本地安装：dsh plugin --profile web add ${tarballPath}`);
console.log(`\n完成 ✅  (v${version})`);
