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
- **新建智能体弹窗**：选择引擎（claude / opencode / codex，自动检测已安装项）、
  命名、**角色定义**（内置预设：数据库专家 / 设计专家 / 前端专家 / 测试专家 /
  代码审查专家 / 架构师，也可自定义）、**挂载技能**（`~/.agents/skills/*`）、
  工作目录 —— 角色与技能会作为开场简报注入该智能体
- **DeepSeek 指挥工具**：`agent_open` / `agent_list` / `agent_read` /
  `agent_send` / `agent_signal` / `agent_close`，总指挥可开智能体、派活、收结果
- **共享记忆协议**：开智能体时自动在工作目录播种
  `.deepseek/memory.md`（长期记忆）、`.deepseek/task-board.md`（任务进度）、
  `.deepseek/experience.md`（工作经验沉淀：结果 / 教训 / 踩坑 / 复用模式）、
  `.deepseek/handoffs/`（智能体间手递手文件），已存在则不覆盖；
  完整模板见仓库 `templates/experience.md`

## 安装

```bash
bash install.sh            # 默认 profile: web
# bash install.sh --profile <name>   # 指定 profile
# bash install.sh --remove           # 卸载
# bash install.sh --skill-only       # 只装 skill
```

装完**重启 DeepSeek Harness** 生效（插件集变更需要重启）。

安装脚本会：
1. 构建 client bundle（`plugin/scripts/build-client.mjs`）
2. 复制插件到 `~/.dsh/profiles/web/node_modules/dsh-agent-commander`
3. 更新 profile 的 `package.json`（dependencies + `dsh.profile.bundles`）
4. 安装 `agent-commander` skill 到 `~/.agents/skills/`

## 使用

1. 重启后，右侧「智能体雷达」面板自动打开（详情栏）
2. 主界面右上角有悬浮的「🤖 雷达」按钮：侧边栏收起时点它**弹出侧边栏**；
   展开时它自动停靠在侧边栏左缘（圆形 🤖），可再点收起 —— 新建空白会话后
   侧边栏若被应用收起，也会自动恢复（或点按钮弹出）
3. 点「＋ 新建」→ 选引擎、写角色（如"数据库专家"）、勾选技能 → 创建
4. 点击智能体行展开实时终端，直接和它对话
5. 对 DeepSeek 说："用 agent_open 打开一个 opencode，角色定为前端专家，
   派它修复 xx 页面的样式问题"，DeepSeek 会按 `agent-commander` skill 指挥团队

## 开发

```
plugin/
├── lib/
│   ├── index.js          # node 端：AgentRegistry + 共享记忆播种 + agent_* 工具 + WS/HTTP 路由
│   └── client.js         # client bundle（构建产物，勿手改）
├── src/client/           # client 源码
│   ├── head.js / tail.js # bundle 骨架
│   ├── app.js            # 雷达面板 + 终端详情 + 新建弹窗
│   ├── panel.css         # 面板样式（DSH design tokens）
│   └── vendor/           # 内联的 xterm 5.5.0 + addon-fit + xterm.css（MIT）
├── scripts/build-client.mjs  # 组装 client.js
├── cordis.patch.yml      # 激活补丁
└── package.json
skill/agent-commander/skill.md  # 总指挥 skill
templates/experience.md           # 经验总结模板
install.sh
```

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
