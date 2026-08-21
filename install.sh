#!/usr/bin/env bash
# =============================================================================
# dsh-agent-commander 一键安装脚本
#
# 1) 构建 client bundle（如未构建）
# 2) 把插件复制进 ~/.dsh/profiles/web/node_modules/dsh-agent-commander（真实目录，
#    保证 node 端依赖 ws/node-pty/@deepseek-ai 能沿 node_modules 向上解析）
# 3) 更新 profile 的 package.json：dependencies + dsh.profile.bundles
# 4) 安装 agent-commander skill 到 ~/.agents/skills/agent-commander/
#
# 用法：
#   bash install.sh            # 安装（默认 profile: web）
#   bash install.sh --remove   # 卸载
#   bash install.sh --profile <name>   # 指定 profile
#   bash install.sh --skill-only        # 只装 skill
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$REPO_DIR/plugin"
SKILL_DIR="$REPO_DIR/skill/agent-commander"
PROFILE="${PROFILE:-web}"
MODE="install"

for arg in "$@"; do
	case "$arg" in
		--remove) MODE="remove" ;;
		--skill-only) MODE="skill-only" ;;
		--profile) ;;
		--profile=*) PROFILE="${arg#--profile=}" ;;
		-*) ;;
		*) PROFILE="$arg" ;;
	esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/dsh-agent-commander"

# 找 Electron 当 node 用（构建 client bundle / 编辑 JSON）
find_node() {
	if command -v node >/dev/null 2>&1; then echo "node"; return; fi
	local app="/Applications/DeepSeek Harness.app"
	if [ -x "$app/Contents/MacOS/DeepSeek Harness" ]; then echo "$app/Contents/MacOS/DeepSeek Harness"; return; fi
	echo ""
}

NODE_BIN="$(find_node)"

echo "== dsh-agent-commander install =="
echo "profile: $PROFILE_DIR"

if [ "$MODE" = "remove" ]; then
	echo "-- 移除插件目录 $TARGET"
	rm -rf "$TARGET"
	if [ -n "$NODE_BIN" ]; then
		ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" -e '
			const fs = require("fs");
			const path = process.argv[1];
			if (!fs.existsSync(path)) process.exit(0);
			const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
			let changed = false;
			if (pkg.dependencies && pkg.dependencies["dsh-agent-commander"]) { delete pkg.dependencies["dsh-agent-commander"]; changed = true; }
			const bundles = pkg.dsh?.profile?.bundles ?? [];
			const idx = bundles.indexOf("dsh-agent-commander");
			if (idx !== -1) { bundles.splice(idx, 1); changed = true; }
			if (changed) fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
			console.log("package.json updated");
		' "$PROFILE_DIR/package.json" || true
	fi
	echo "-- 移除 skill"
	rm -rf "$HOME/.agents/skills/agent-commander"
	echo "== 已卸载。重启 DeepSeek Harness 生效。=="
	exit 0
fi

if [ "$MODE" = "skill-only" ]; then
	mkdir -p "$HOME/.agents/skills/agent-commander"
	cp "$SKILL_DIR/skill.md" "$HOME/.agents/skills/agent-commander/skill.md"
	echo "== skill 已安装到 ~/.agents/skills/agent-commander/ =="
	exit 0
fi

# 1) 构建 client bundle
if [ -n "$NODE_BIN" ]; then
	if [ ! -f "$PLUGIN_DIR/lib/client.js" ] || [ -n "${REBUILD:-}" ]; then
		echo "-- 构建 client bundle"
		ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" "$PLUGIN_DIR/scripts/build-client.mjs"
	else
		echo "-- client bundle 已存在（$PLUGIN_DIR/lib/client.js）"
	fi
else
	if [ ! -f "$PLUGIN_DIR/lib/client.js" ]; then
		echo "错误：未找到 node/Electron，且 lib/client.js 不存在，无法构建。" >&2
		exit 1
	fi
	echo "-- 复用已有 client bundle"
fi

# 2) 复制插件（真实目录，保证依赖可解析）
echo "-- 复制插件到 $TARGET"
mkdir -p "$PROFILE_DIR/node_modules"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$PLUGIN_DIR/lib" "$TARGET/lib"
cp "$PLUGIN_DIR/package.json" "$TARGET/package.json"
cp "$PLUGIN_DIR/cordis.patch.yml" "$TARGET/cordis.patch.yml"
[ -f "$PLUGIN_DIR/README.md" ] && cp "$PLUGIN_DIR/README.md" "$TARGET/README.md"

# 3) 更新 profile package.json
if [ -n "$NODE_BIN" ]; then
	ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" -e '
		const fs = require("fs");
		const path = process.argv[1];
		const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
		pkg.dependencies = pkg.dependencies ?? {};
		pkg.dependencies["dsh-agent-commander"] = "0.1.0";
		pkg.dsh = pkg.dsh ?? {};
		pkg.dsh.profile = pkg.dsh.profile ?? {};
		const bundles = pkg.dsh.profile.bundles ?? [];
		if (!bundles.includes("dsh-agent-commander")) bundles.push("dsh-agent-commander");
		pkg.dsh.profile.bundles = bundles;
		fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
		console.log("-- package.json: dependencies + bundles 已更新");
	' "$PROFILE_DIR/package.json"
else
	echo "警告：未找到 node，无法自动编辑 $PROFILE_DIR/package.json，请手动添加：" >&2
	echo '  "dependencies": { "dsh-agent-commander": "0.1.0" }' >&2
	echo '  "dsh.profile.bundles": [... , "dsh-agent-commander"]' >&2
fi

# 4) 安装 skill
mkdir -p "$HOME/.agents/skills/agent-commander"
cp "$SKILL_DIR/skill.md" "$HOME/.agents/skills/agent-commander/skill.md"
echo "-- skill 已安装到 ~/.agents/skills/agent-commander/"

echo
echo "== 安装完成！请重启 DeepSeek Harness 生效。=="
echo "   重启后：右侧会出现「智能体雷达」面板（自动打开），点「＋ 新建」开智能体；"
echo "   DeepSeek 可用 agent_open / agent_send 等工具指挥团队（skill: agent-commander）。"
