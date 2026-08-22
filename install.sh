#!/usr/bin/env bash
# =============================================================================
# dsh-agent-commander 安装脚本（标准安装优先）
#
# 标准安装（官方文档 docs/user/develop/basic/publish.md 流程）：
#   1) 构建 client bundle（如未构建）
#   2) 用 `dsh plugin --profile <name> add <插件目录>` 把插件作为组合包
#      (bundle) 装进 profile —— dsh 在 profile 目录内转发给 pnpm 安装，
#      并根据 `dsh.bundle` 声明自动把它追加进 dsh.profile.bundles 层栈
#   3) 安装 agent-commander skill 到 ~/.agents/skills/agent-commander/
#
# 找不到 dsh CLI / pnpm 时回退到旧的手动复制方式（真实目录拷贝 +
# 直接编辑 profile package.json）。
#
# 用法：
#   bash install.sh            # 安装（默认 profile: web）
#   bash install.sh --remove   # 卸载
#   bash install.sh --profile <name>   # 指定 profile
#   bash install.sh --skill-only        # 只装 skill
#   bash install.sh --manual            # 强制手动复制（不用标准流程）
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$REPO_DIR/plugin"
# skill 随插件包一起分发（plugin/skill/agent-commander/skill.md），插件启动时也会
# 自动把它装到 ~/.agents/skills/agent-commander/（无需单独安装）。
SKILL_DIR="$PLUGIN_DIR/skill/agent-commander"
PROFILE="${PROFILE:-web}"
MODE="install"
FORCE_MANUAL=""

for arg in "$@"; do
	case "$arg" in
		--remove) MODE="remove" ;;
		--skill-only) MODE="skill-only" ;;
		--manual) FORCE_MANUAL="1" ;;
		--profile) ;;
		--profile=*) PROFILE="${arg#--profile=}" ;;
		-*) ;;
		*) PROFILE="$arg" ;;
	esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/dsh-agent-commander"

# 找 Electron 当 node 用（构建 client bundle / 编辑 JSON / 跑 dsh CLI）
find_node() {
	if command -v node >/dev/null 2>&1; then echo "node"; return; fi
	local app="/Applications/DeepSeek Harness.app"
	if [ -x "$app/Contents/MacOS/DeepSeek Harness" ]; then echo "$app/Contents/MacOS/DeepSeek Harness"; return; fi
	echo ""
}

# 找 dsh CLI（优先 PATH，其次 nvm，最后应用内置的 host checkout）
find_dsh_cli() {
	if command -v dsh >/dev/null 2>&1; then echo "$(command -v dsh)"; return; fi
	for dir in "$HOME"/.nvm/versions/node/*/bin; do
		[ -x "$dir/dsh" ] && echo "$dir/dsh" && return
	done
	local host="/Applications/DeepSeek Harness.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js"
	[ -f "$host" ] && echo "$host" && return
	echo ""
}

NODE_BIN="$(find_node)"
DSH_CLI="$(find_dsh_cli)"

echo "== dsh-agent-commander install =="
echo "profile: $PROFILE_DIR"

if [ "$MODE" = "remove" ]; then
	if [ -n "$DSH_CLI" ] && [ -z "$FORCE_MANUAL" ] && command -v pnpm >/dev/null 2>&1; then
		echo "-- 标准卸载（dsh plugin remove）"
		"$NODE_BIN" "$DSH_CLI" plugin --profile "$PROFILE" remove dsh-agent-commander || true
	else
		echo "-- 手动卸载插件目录 $TARGET"
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

# 2) 标准安装：dsh plugin add（pnpm 转发 + bundles 层栈自动合并）
INSTALLED_STANDARD=""
if [ -n "$DSH_CLI" ] && [ -z "$FORCE_MANUAL" ]; then
	# 让 pnpm（nvm/corepack 安装的）可被 dsh 找到
	export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
	if command -v pnpm >/dev/null 2>&1; then
		echo "-- 标准安装（dsh plugin add，pnpm 管理依赖与 bundles 层栈）"
		if "$NODE_BIN" "$DSH_CLI" plugin --profile "$PROFILE" add "$PLUGIN_DIR"; then
			INSTALLED_STANDARD="1"
		else
			echo "警告：标准安装失败，回退到手动复制。若因网络/构建权限失败，可先执行："
			echo "  dsh plugin --profile $PROFILE add $PLUGIN_DIR"
			echo "  （首次 git 依赖需在 $PROFILE_DIR/pnpm-workspace.yaml 的 allowBuilds 放行）"
		fi
	else
		echo "警告：未找到 pnpm，回退到手动复制（标准流程需要 pnpm）。"
	fi
else
	echo "-- 未找到 dsh CLI（或 --manual），使用手动复制方式"
fi

# 3) 手动复制（回退路径）
if [ -z "$INSTALLED_STANDARD" ]; then
	echo "-- 复制插件到 $TARGET"
	mkdir -p "$PROFILE_DIR/node_modules"
	rm -rf "$TARGET"
	mkdir -p "$TARGET"
	cp -R "$PLUGIN_DIR/lib" "$TARGET/lib"
	cp "$PLUGIN_DIR/package.json" "$TARGET/package.json"
	cp "$PLUGIN_DIR/cordis.patch.yml" "$TARGET/cordis.patch.yml"
	[ -f "$PLUGIN_DIR/README.md" ] && cp "$PLUGIN_DIR/README.md" "$TARGET/README.md"

	if [ -n "$NODE_BIN" ]; then
		ELECTRON_RUN_AS_NODE=1 "$NODE_BIN" -e '
			const fs = require("fs");
			const path = process.argv[1];
			const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
			pkg.dependencies = pkg.dependencies ?? {};
			pkg.dependencies["dsh-agent-commander"] = "0.2.0";
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
		echo '  "dependencies": { "dsh-agent-commander": "0.2.0" }' >&2
		echo '  "dsh.profile.bundles": [... , "dsh-agent-commander"]' >&2
	fi
fi

# 4) 安装 skill
mkdir -p "$HOME/.agents/skills/agent-commander"
cp "$SKILL_DIR/skill.md" "$HOME/.agents/skills/agent-commander/skill.md"
echo "-- skill 已安装到 ~/.agents/skills/agent-commander/"

echo
echo "== 安装完成！请重启 DeepSeek Harness 生效。=="
echo "   重启后：右侧会出现「智能体雷达」面板（自动打开），点「＋ 新建」开智能体；"
echo "   DeepSeek 可用 agent_open / agent_send 等工具指挥团队（skill: agent-commander）。"
