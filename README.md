# dsh-agent-commander

**多智能体总指挥插件（DeepSeek Harness 原生版）** —— 让 DeepSeek 打开并指挥一个
**claude / opencode / codex 智能体团队**，实时看到每个智能体在做什么，通过共享记忆
与任务看板高效编排多人协作。

```
┌────────────────────────────────────────────┐
│ DeepSeek Harness                           │
│ ┌──────────────────────┐  ┌──────────────┐ │
│ │ 中间：聊天区（原生）   │  │ 右侧：智能体雷达 │ │
│ │ 你 ↔ DeepSeek(总指挥) │  │  claude  working│ │
│ └──────────────────────┘  │  opencode idle  │ │
│                            │  点击→实时终端   │ │
│                            │  ＋新建(角色+技能)│ │
│                            └──────────────┘ │
└────────────────────────────────────────────┘
```

## ✨ 功能亮点

- **智能体雷达（右侧详情栏）**：所有已打开的智能体列表，实时状态徽标（working /
  idle / blocked / exited）、角色、工作目录；点击展开**实时终端**（xterm +
  WebSocket + node-pty），可直接打字与智能体交互
- **工作区隔离 + 自动重检**：雷达列表按当前工作区（会话工作目录）隔离；切换工作区
  自动重新检测并恢复 `.deepseek/agents.json` 中保存的未运行智能体
- **新建智能体弹窗**：选引擎（自动检测 claude / opencode / codex 是否安装）、命名、
  **角色定义**（内置 6 个预设：数据库专家 / 设计专家 / 前端专家 / 测试专家 /
  代码审查专家 / 架构师）、**挂载技能**（`~/.agents/skills/*`）—— 角色与技能作为
  开场简报自动注入并回车执行
- **DeepSeek 指挥工具**：`agent_open` / `agent_list` / `agent_read` / `agent_send` /
  `agent_broadcast` / `agent_signal` / `agent_close`，总指挥可在对话里直接开智能体、
  派活、收结果
- **共享记忆协议**：开智能体时自动播种 `.deepseek/memory.md`（长期记忆）、
  `.deepseek/task-board.md`（任务进度）、`.deepseek/experience.md`（经验沉淀）、
  `.deepseek/handoffs/`（交接文件）与 SQLite 知识库 `memory.db` —— 所有智能体
  读写同一份，天然共享上下文
- **安全设计**：路径穿越防护、请求体上限、环境变量白名单、信号白名单、
  Trust fence、自动审批仅限启动阶段

## 📦 安装

### 方式一：GitHub 直接安装（推荐）

```bash
# 安装最新 main 分支
dsh plugin add github:qinglang8609/deepseek_herdr

# 或锁定到发布 tag
dsh plugin add github:qinglang8609/deepseek_herdr#v0.2.1
```

> 首次安装若提示 `ERR_PNPM_IGNORED_BUILDS`（node-pty 构建脚本），在 profile 目录
> 执行 `pnpm approve-builds` 放行 node-pty 即可。

### 方式二：tarball 安装

```bash
cd plugin && pnpm pack
dsh plugin --profile web add ./dsh-agent-commander-0.2.1.tgz
```

### 方式三：一键脚本（自动标准流程 + 回退）

```bash
bash install.sh            # 默认 profile: web；优先走 dsh plugin add 标准流程
# bash install.sh --profile <name>   # 指定 profile
# bash install.sh --remove           # 卸载
# bash install.sh --skill-only       # 只装 skill
```

装完**重启 DeepSeek Harness** 生效（插件集变更需要重启）。

## 🚀 快速开始

1. 重启后，右侧「智能体雷达」面板自动打开（主界面右上角有悬浮「🤖 雷达」按钮可弹出/收起）
2. 点「＋ 新建」→ 选引擎、写角色（如"数据库专家"）、勾选技能 → 创建
3. 点击智能体行展开实时终端，直接和它对话
4. 对 DeepSeek 说：
   > "用 agent_open 打开一个 opencode，角色定为前端专家，派它修复 xx 页面的样式问题"
5. 切换工作区时，雷达会自动重新检测新文件夹的智能体列表

## ⚙️ 配置（Config schema）

插件导出标准 Schemastery Config schema，所有参数可在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: agent-commander
  config:
    maxAgents: 12              # 同时打开的最大智能体数（默认 8）
    rolePresets:
      - 数据库专家
      - 安全专家              # 自定义预设会出现在「新建智能体」弹窗里
    memoryDir: .deepseek       # 共享记忆目录名（默认 .deepseek）
    allowedSignals: [SIGINT, SIGTSTP, SIGTERM]
```

完整字段表见 [plugin/README.md](plugin/README.md#配置config-schema)。

## 🔧 开发

```
plugin/
├── lib/
│   ├── index.js          # node 端：Config schema + AgentRegistry + 共享记忆 + agent_* 工具 + WS/HTTP 路由
│   └── client.js         # client bundle（构建产物，勿手改）
├── src/client/           # client 源码（app.js 雷达面板 / panel.css / vendor 内联 xterm）
├── skill/agent-commander/skill.md  # 总指挥 skill（随插件包分发，启动时自动装到 ~/.agents/skills/）
├── scripts/build-client.mjs  # 组装 client.js
├── cordis.patch.yml      # 激活补丁
└── package.json
templates/experience.md   # 经验总结模板
install.sh                # 一键安装脚本
```

改完 client 源码后重新构建：

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" plugin/scripts/build-client.mjs
bash install.sh
```

node 端实现为 **cordis Service 类**（`AgentCommanderService`），其他插件只需
`inject: ['agentCommander']` 即可调用其公开 API（`list` / `open` / `send` / `read` /
`approve` / `signal` / `close` / `memory.*` / `scan` / `restore`），详见
[plugin/README.md](plugin/README.md#标准插件形态cordis-service)。

## 🏷 版本历史

| 版本 | 内容 |
|------|------|
| **v0.2.1** | 修复 4 CRITICAL + 5 HIGH（渲染期 ref 副作用 / WebSocket 泄漏 / 竞态 / prompt 注入 / schema 文档不一致 / VACUUM 吞错 / resize 节流 / busy 未重置）+ 状态卡死专项（周期巡检 idle 回落）；支持 `dsh plugin add github:...` 直接安装 |
| **v0.2.0** | 插件标准化：Config schema、tarball 标准安装、skill 随包分发、SQLite 记忆层、依赖解析兜底 |

## 📄 许可

详见 [plugin/README.md](plugin/README.md) 与插件包内文件。
