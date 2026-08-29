# dsh-agent-commander

多智能体总指挥插件（DeepSeek Harness 原生版）—— 让 DeepSeek 打开并指挥一个
**claude / opencode / codex 团队**，实时看到每个智能体在做什么，共享记忆与任务进度。

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

## 功能

- **智能体雷达（右侧详情栏）**：所有已打开的智能体列表，实时状态徽标
  （working / idle / blocked / exited）、角色、工作目录；点击任一智能体展开
  **实时终端**（xterm + WebSocket + node-pty），可直接打字与智能体交互
- **工作区隔离 + 自动重检**：雷达列表**按当前工作区（会话工作目录）隔离**，
  只显示本文件夹（含子目录）的智能体；**每次切换工作区都会自动重新检测**——
  扫描该文件夹 `.deepseek/agents.json`，恢复其中未运行的已保存智能体；
  面板头部显示当前文件夹，↻ 按钮可手动重新检测（`agent_list` 工具同样按
  当前工作区隔离）
- **关闭即删除**：**所有智能体配置收拢在项目根目录 `.deepseek/agents.json`**
  （以创建时的会话工作目录为项目根，子目录智能体也写回根目录）。**只有存活
  的智能体会写入配置**——关闭 / 退出的智能体立即从配置删除，重启后不会以
  「恢复」形式复活；只有「上次在跑、重启后却拉起失败」（如引擎未安装）的
  智能体才显示为「已保存·未运行」卡片，可 ⏻ 重试或 ✕ 删除记录。配置里
  **不再保存 transcriptTail**（原始终端字节是乱码，对恢复毫无用处）
- **新建智能体弹窗**：选择引擎（claude / opencode / codex，自动检测已安装项）、
  命名、**角色定义**（内置预设：数据库专家 / 设计专家 / 前端专家 / 测试专家 /
  代码审查专家 / 架构师，也可自定义）、**挂载技能**（`~/.agents/skills/*`）、
  工作目录 —— 角色与技能会作为开场简报注入该智能体
- **DeepSeek 指挥工具**：`agent_open` / `agent_list` / `agent_read` /
  `agent_send` / `agent_signal` / `agent_close`，总指挥可开智能体、派活、收结果
  （`agent_list` 只返回**当前工作区**的智能体）
- **共享记忆协议**：开智能体时自动在工作目录播种
  `.deepseek/memory.md`（长期记忆）、`.deepseek/task-board.md`（任务进度）、
  `.deepseek/experience.md`（工作经验沉淀：结果 / 教训 / 踩坑 / 复用模式）、
  `.deepseek/handoffs/`（智能体间手递手文件），已存在则不覆盖；
  完整模板见仓库 `templates/experience.md`

## 安装

### GitHub 安装（推荐，`dsh plugin add github:...`）

仓库根已带 `package.json` 包装（name=dsh-agent-commander），可直接从 GitHub 安装：

```bash
# 安装最新 main 分支
dsh plugin add github:qinglang8609/deepseek_herdr

# 或锁定到发布 tag
dsh plugin add github:qinglang8609/deepseek_herdr#v0.2.1
```

> 首次安装若提示 node-pty 构建脚本被忽略（`ERR_PNPM_IGNORED_BUILDS`），在 profile 目录
> 执行 `pnpm approve-builds` 放行 node-pty 即可。

### tarball 安装（`dsh plugin add` + tarball）

本插件是符合官方标准的**组合包（bundle）**：`package.json` 声明 `dsh.bundle.patch`
（`cordis.patch.yml`），用官方流程装进 profile（见
[docs/user/develop/basic/publish.md](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）：

```bash
# 从本仓库目录：先打发布 tarball（已附在仓库 plugin/ 下），再标准安装：
cd plugin && pnpm pack
dsh plugin --profile web add ./dsh-agent-commander-0.2.1.tgz
```

> **为什么用 tarball 而不是 `dsh plugin add ./plugin`？** 目录安装会被 pnpm 按
> `link:` 处理——不安装插件自身的依赖，且插件模块按真实路径解析时，顶层裸导入
> （`@deepseek-ai/dsh-tools` 等）会 `ERR_MODULE_NOT_FOUND`（已实测）。tarball 安装
> 为 profile 里的**真实目录**并装齐 `node-pty`/`ws` 依赖，`@deepseek-ai/*` 经
> `~/.dsh/profiles/node_modules` 的应用依赖镜像解析——这就是官方「交付 tarball」
> 推荐路径。`file:<目录>` 效果相同，但首次需在 profile 的 `pnpm-workspace.yaml`
> 放行 `allowBuilds: node-pty: true`。

`dsh plugin` 会在 profile 目录内转发给 pnpm 安装，并根据 `dsh.bundle` 声明自动把
`dsh-agent-commander` 追加进 `dsh.profile.bundles` 层栈。装完**重启 DeepSeek Harness**
生效（插件集变更需要重启）。

### 一键脚本（自动标准流程 + 回退）

```bash
bash install.sh            # 默认 profile: web；优先走 dsh plugin add 标准流程
# bash install.sh --profile <name>   # 指定 profile
# bash install.sh --remove           # 卸载
# bash install.sh --skill-only       # 只装 skill
# bash install.sh --manual           # 强制手动复制（无 dsh CLI/pnpm 时自动回退）
```

脚本会：
1. 构建 client bundle（`plugin/scripts/build-client.mjs`）
2. 有 `dsh` CLI + `pnpm` 时走标准 `dsh plugin add`；否则回退为手动复制插件到
   `~/.dsh/profiles/web/node_modules/dsh-agent-commander` 并更新 profile 的
   `package.json`（dependencies + `dsh.profile.bundles`）
3. 安装随插件分发的 `agent-commander` skill 到 `~/.agents/skills/`
   （标准安装下由插件启动时自动完成，脚本会兜底同步一次）

## 配置（Config schema）

插件导出标准 **Schemastery Config schema**（`lib/index.js` 中的 `export const Config`），
所有可调参数都能在 `cordis.yml` 里改，无需改代码（官方约定：
[docs/user/develop/basic/config.md](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config)）。
在 profile 的 `cordis.patch.yml` 覆盖对应行：

```yaml
- id: agent-commander
  config:
    maxAgents: 12              # 同时打开的最大智能体数（默认 8）
    transcriptLimit: 2097152   # 每个智能体转录环上限字节（默认 1 MiB）
    rolePresets:
      - 数据库专家
      - 设计专家
      - 前端专家
      - 测试专家
      - 代码审查专家
      - 架构师
      - 安全专家              # 自定义预设会出现在「新建智能体」弹窗里
    memoryDir: .deepseek       # 共享记忆目录名（默认 .deepseek）
    allowedSignals: [SIGINT, SIGTSTP, SIGTERM]
    baseCwd: /path/to/project  # 无会话工作目录时的默认项目根
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `maxAgents` | number | 8 | 同时打开的智能体上限 |
| `transcriptLimit` | number | 1048576 | 每个智能体转录环上限（字节） |
| `bodyLimit` | number | 1048576 | HTTP API 请求体上限（字节） |
| `wsInputLimit` | number | 65536 | 终端 WebSocket 单帧输入上限（字节） |
| `allowedSignals` | string[] | SIGINT/SIGTSTP/SIGTERM | 允许通过 API/终端发送的信号 |
| `rolePresets` | string[] | 6 个内置预设 | 「新建智能体」弹窗的角色预设 |
| `baseCwd` | string | "" | 无会话工作目录时的默认项目根（空=进程 cwd） |
| `memoryDir` | string | ".deepseek" | 共享记忆目录名（memory.md / task-board.md / agents.json / memory.db 等） |
| `agentHost` | "auto" \| "herdr" \| "legacy" | "auto" | 智能体宿主：auto 检测到 herdr 二进制即用 herdr；herdr 强制 herdr；legacy 回退 node-pty（详见 `docs/herdr-integration-dev.md`） |

运行时配置快照还通过 `GET /agent-commander/api/config` 暴露给客户端（角色预设、
引擎列表、限额），客户端「新建智能体」弹窗会优先使用服务端配置的 `rolePresets`。

## 发布（发布产物）

按官方打包教程（publish.md），插件可分发为：

- **tarball（无需构建权限，推荐）**：在 `plugin/` 下执行 `pnpm pack`，得到
  `dsh-agent-commander-0.2.0.tgz`；用户 `dsh plugin add ./dsh-agent-commander-0.2.0.tgz`。
- **git 安装**：`dsh plugin add github:qinglang8609/deepseek_herdr`（仓库根目录需是
  插件包根；本仓库插件在 `plugin/` 子目录，因此推荐 tarball 或 `dsh plugin add ./plugin`）。
  git 安装拉的是源码，靠 `package.json` 的 `prepare` 脚本构建 client bundle；
  pnpm ≥10 需在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行该包。
- **npm 发布**：`pnpm publish`（发布前自动跑 `prepare` 构建好 `lib/`）。

## 使用

1. 重启后，右侧「智能体雷达」面板自动打开（详情栏）
2. 主界面右上角有悬浮的「🤖 雷达」按钮：侧边栏收起时点它**弹出侧边栏**；
   展开时它自动停靠在侧边栏左缘（圆形 🤖），可再点收起 —— 新建空白会话后
   侧边栏若被应用收起，也会自动恢复（或点按钮弹出）
3. 点「＋ 新建」→ 选引擎、写角色（如"数据库专家"）、勾选技能 → 创建
4. 点击智能体行展开实时终端，直接和它对话
5. 对 DeepSeek 说："用 agent_open 打开一个 opencode，角色定为前端专家，
   派它修复 xx 页面的样式问题"，DeepSeek 会按 `agent-commander` skill 指挥团队
6. **切换工作区（新会话/换目录）时，雷达会自动重新检测新文件夹的智能体列表**：
   恢复 `.deepseek/agents.json` 中保存的未运行智能体、列出「已保存·未运行」的
   已退出智能体（可点 ⏻ 恢复）；↻ 按钮可随时手动重新检测

## 开发

```
plugin/
├── lib/
│   ├── index.js          # node 端：Config schema + AgentRegistry + 共享记忆播种 + agent_* 工具 + WS/HTTP 路由
│   └── client.js         # client bundle（构建产物，勿手改）
├── src/client/           # client 源码
│   ├── head.js / tail.js # bundle 骨架
│   ├── app.js            # 雷达面板 + 终端详情 + 新建弹窗
│   ├── panel.css         # 面板样式（DSH design tokens）
│   └── vendor/           # 内联的 xterm 5.5.0 + addon-fit + xterm.css（MIT）
├── skill/agent-commander/skill.md  # 总指挥 skill（随插件包分发，启动时自动装到 ~/.agents/skills/）
├── scripts/build-client.mjs  # 组装 client.js
├── cordis.patch.yml      # 激活补丁
└── package.json
templates/experience.md           # 经验总结模板
install.sh
```

**skill 随插件一起分发**：`skill/agent-commander/skill.md` 在插件包内（`package.json` 的
`files` 已包含 `skill/`，tarball 会带上），插件启动时自动把它同步到
`~/.agents/skills/agent-commander/`（只在缺失或内容不同时写入，不覆盖用户改动）——
因此 `dsh plugin add` 装完插件即装完 skill，无需单独步骤。

改完 client 源码后重新构建：

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" plugin/scripts/build-client.mjs
bash install.sh
```


## 标准插件形态（cordis Service）

node 端按 DSH 官方标准实现为 **cordis Service 类**（`AgentCommanderService extends Service`，
见 `lib/index.js` 底部）：`new Service(ctx, 'agentCommander')` 自动把实例注册为
`agentCommander` 服务，**其他插件只需 `inject: ['agentCommander']` 即可使用**：

```js
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-consumer'
export const inject = ['agentCommander']

export function apply(ctx: Context) {
  // ctx.agentCommander 已就绪
  const agents = ctx.agentCommander.list()
  ctx.agentCommander.open({ type: 'claude', role: '数据库专家' })
  ctx.agentCommander.send(agents[0].id, '审查一下 package.json', true)
  ctx.agentCommander.memory.add({ namespace: 'experience', title: '...', body: '...' })
}
```

标准导出：`name` / `inject` / `apply`（函数形态委托给 Service 类），三形态规范兼容。

### 服务公开 API

| 方法 | 说明 |
|------|------|
| `list()` / `status(id)` | 智能体列表 / 单个状态 |
| `open(opts)` | 打开智能体（type/name/role/skills/cwd） |
| `send(id, text, submit)` / `read(id, bytes)` | 发消息 / 读输出 |
| `approve(id, choice)` | 点击确认弹窗（默认选 1=Yes） |
| `signal(id, sig)` / `close(id, graceful)` | 信号 / 关闭（graceful 先 /exit） |
| `memory.query/add/list` | SQLite 记忆层读写 |
| `scan(cwd)` | 重新检测某工作区的智能体（恢复其中已保存的未运行智能体，并清理已关闭/已退出的记录） |
| `restore(id, cwd)` / `forget(id, cwd)` | 恢复某条保存记录 / 删除某条保存记录 |

## 说明与限制

- 智能体是真实 CLI 进程（`claude` / `opencode` / `codex`），交互方式是"终端文本"，
  类似人类指挥官打字 —— 指令质量决定协作质量（见 skill 的指令三要素）
- 雷达面板是**应用原生右侧栏**（融入三栏布局，非悬浮层）；应用自身的详情栏
  （轨迹/工具检查）被其占用后，该视图在聊天区内的标签页仍可使用
- 空白会话时 AppFrame 默认不给详情栏宽度，插件会自动接管最后一列网格轨道（380px）
  保证面板始终可见；用户拖拽调宽时尊重应用的值
- 智能体进程在会话间保持存活；关闭面板/刷新页面不会杀进程
- 状态识别基于输出启发式（`✢` 工作中 / `❯` 空闲 / `⏸` 受阻），为尽力而为
- 依赖 `node-pty`（spawn-helper 执行位丢失时插件会自动修复）
