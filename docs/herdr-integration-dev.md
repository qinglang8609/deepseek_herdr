# herdr 集成开发文档（Agent Radar 迁移到 herdr）

> 分支：`feat/herdr-adapter` ｜ 版本：draft v0.1 ｜ 更新：2026-08-29
>
> 目标：把「智能体雷达」的智能体宿主从 DSH 插件进程（node-pty）迁移到
> **herdr**（后台 server + socket API 的终端工作区管理器），解决两个长期问题：
> ① DSH Web GUI 右侧面板窗口太小；② 长时间运行后浏览器 xterm 渲染卡死。
> 共享记忆协议（`.deepseek/`）与 commander 方法论不变。

---

## 1. 背景与问题

| # | 现象 | 根因 |
|---|------|------|
| 1 | 侧边栏窗口太小 | 智能体终端渲染在 DSH Web GUI 右侧小面板内 |
| 2 | 跑久了卡死 | xterm.js + WebSocket + node-pty 长会话渲染内存累积 |

herdr 是独立于 DSH 的进程：**后台 server 持有真实终端进程，客户端（TUI/CLI）
只是附着渲染**。智能体跑在 herdr 里，天然不受 DSH GUI 状态影响；总指挥通过
`herdr` CLI（socket API）读写，纯文本、无浏览器渲染，根治上述两个问题。

## 2. 现状（已核实的 herdr 环境）

- herdr **0.8.2** stable 已安装（`~/.local/bin/herdr`）且 server 在运行
  （socket：`~/.config/herdr/herdr.sock`）
- 集成已装好：`claude` v8（hook）、`codex` v8（hook）、`opencode` v10（plugin）——
  这三个引擎的状态（working / blocked / done / idle）自动上报
- `codebuddy` / `pi` / `qwen` 集成未装（需要时 `herdr integration install <kind>`）
- 3+1 个工作区：`wB`(~) / `wD`(plan_monitoring) / `wF`(Docker) / `wG`(deepseek_herdr，本次试点新建)

## 3. 目标架构

```
现在:    DSH插件(AgentRegistry, node-pty spawn) → WS → 侧边栏(xterm 渲染) ← 卡死根源
改造后:  herdr server(持有真实进程) → herdr CLI(socket) → HerdrAdapter/HerdrRegistry(插件内)
         → WS → 侧边栏(纯状态 + 只读 tail，不再渲染 xterm)
```

- **智能体宿主**：herdr server（断开/重启/卡死都不丢进程）
- **总指挥工具**：`agent_*` 工具签名**保持不变**，内部改走 herdr
- **侧边栏**：从「终端宿主 + 渲染器」降级为「遥控面板 + 只读视图」
- **回退**：herdr 不可用时自动回退 legacy node-pty 模式（插件不绑死 herdr）

## 4. 概念映射

| DSH 概念 | herdr 概念 | 说明 |
|---------|-----------|------|
| 智能体 id（`a3f9c2d1`） | **herdr agent 名字**（`[a-z][a-z0-9_-]{0,31}`）+ pane id（`wG:p2`） | DSH id 是展示句柄；内部持 `{id → herdrName, paneId}` 映射 |
| 智能体中文名「数据库专家-张三」 | 仅展示；herdrName 用 slug 化（如 `db-zhangsan`）+ 短随机后缀 | herdr 名字规则：小写 ASCII |
| 工作目录 cwd | herdr **workspace**（`--cwd` 创建） | 一个项目 = 一个 workspace |
| 引擎 type（claude/opencode/codex…） | `agent start --kind <kind>` | codebuddy 在 herdr kinds 中不存在 → 报错提示 |
| 状态 working/idle/blocked/exited | herdr idle/done/working/blocked/unknown | 映射见 §6 |

## 5. 模块设计

### 5.1 `plugin/lib/herdr-adapter.js`（新增，纯 herdr CLI 封装，零依赖）

```js
class HerdrAdapter {
  // 二进制发现：PATH → ~/.local/bin → /opt/homebrew/bin → /usr/local/bin
  static findBinary()
  // 探测可用性：herdr status → {available, version, reason}
  static probe()
  // 统一 execFile：args → JSON 信封 {id, result} 解析、超时、错误分类
  async call(args, { timeoutMs } = {})
  // 工作区
  async workspaceList(); async workspaceCreate(cwd, label)
  // 面板
  async paneList(); async paneSplit(paneId, dir, cwd); async paneRead(paneId, lines)
  async paneSendText(paneId, text); async paneSendKeys(paneId, keys); async paneClose(paneId)
  // 智能体
  async agentList(); async agentGet(name)
  async agentStart(name, kind, paneId, { timeoutMs } = {})
  async agentRead(name, lines); async agentPrompt(name, text, { wait, until, timeoutMs })
  async agentWait(name, { until, timeoutMs }); async agentSendKeys(name, keys)
  async integrationStatus()
  // 自检：status + workspaceList + agentList 三连
  async selftest()
}
```

要点：
- 所有输出按 JSON 解析（herdr CLI 非 TTY 时输出 `{id, result}` 信封）
- 超时统一处理；`agent start` 就绪超时默认 60s（最大 300s）
- 错误分类：`HERDR_NOT_FOUND` / `HERDR_SERVER_DOWN` / `AGENT_NOT_READY` /
  `AGENT_BLOCKED` / `AGENT_PROMPT_STALLED` / `TIMEOUT`

### 5.2 `plugin/lib/herdr-registry.js`（新增，注册表门面）

实现与 `AgentRegistry` 相同的工具/WS 消费接口（`agents` Map、`list`、
`listByCwd`、`get`、`create`、`read`、`send`、`approve`、`signal`、`close`、
`compactSession`、`subscribe`、`meta`、`shutdown` + legacy 只读 stub），内部全走
`HerdrAdapter`：

- **create()**（async）：解析 cwd → 确保 workspace → `paneSplit` →
  `agentStart --kind` → 注入开场简报（`agent prompt <briefing> --wait`）→
  登记映射 → 返回 handle。角色+技能简报内容与 legacy 版一致（读
  `.deepseek/memory.md` 协议 + 角色定义 + 技能清单）
- **list()**：`agentList()` 全量 + 本地缓存合并 → DSH handle 形状
- **read()**：`agentRead(name, lines)` → `{output, truncated, exited, status, exitCode}`
- **send()**：`agentPrompt(name, text)`（submit=true）；纯文本 `paneSendText` + `sendKeys Enter`
- **approve()**：blocked → `agentRead` 看弹窗 → `sendKeys Enter` 或 `prompt choice`
- **signal()**：SIGINT→`sendKeys ctrl+c`；SIGTSTP→`sendKeys ctrl+z`；
  SIGTERM→`sendKeys ctrl+c`（herdr 仅逻辑键，文档注明限制）
- **close()**：`prompt "/exit"` → `agentWait done` → `paneClose`；超时强制 `paneClose`
- **subscribe()**：2s 轮询 `agentList`，状态/集合变化时通知（供 attachList WS 推送）
- **meta() / 状态映射**：见 §6

### 5.3 `lib/index.js` 接线（最小改动）

1. Config schema 新增 `agentHost: "auto" | "herdr" | "legacy"`（默认 `auto`）
2. 构造器：`agentHost === "herdr"` 或（`auto` 且 `probe()` 通过）→ 用
   `HerdrAgentRegistry`；否则 legacy `AgentRegistry`；强制 herdr 但不可用 →
   warn + 回退 legacy
3. `agent_open` 的 execute 改 `Promise.resolve(registry.create(...)).then(...)`
   （兼容 legacy 同步 / herdr 异步两种 create）
4. 工具注册条件：`nodePty !== null || useHerdr`
5. `restoreState()` 仅在 legacy 模式调用（herdr 进程天然存活，无需恢复）

## 6. 状态映射

| herdr | DSH 侧边栏徽标 | 说明 |
|-------|--------------|------|
| `working` | working（蓝） | 工作中 |
| `blocked` | blocked（红） | 等待审批/提问 → 用 agent_approve |
| `done` | idle（灰绿） | 后台工作完成、已就绪 |
| `idle` | idle（灰） | 就绪待命 |
| `unknown` | unknown | 无法分类（刚启动/无集成），不视为完成 |
| 不在 agentList | exited | 已退出 |

## 7. 工具映射

| DSH 工具 | herdr 实现 | 备注 |
|---------|-----------|------|
| `agent_open` | workspace 确保 → paneSplit → agentStart → 简报注入 | async；角色+技能注入保留 |
| `agent_list` | agentList + 缓存合并 | 支持 scope=all/按 cwd 过滤 |
| `agent_read` | agentRead `--source recent-unwrapped --lines` | ANSI 剥离 |
| `agent_send` | agentPrompt（submit=true） | `--wait` 可选 |
| `agent_approve` | blocked 检测 → sendKeys Enter / prompt choice | 先读弹窗再确认 |
| `agent_signal` | sendKeys ctrl+c / ctrl+z | SIGTERM→ctrl+c（限制注明） |
| `agent_close` | prompt /exit → wait done → paneClose | 优雅退出优先 |
| `agent_broadcast` | 循环 agentPrompt | — |
| `agent_compact` | prompt /compact（claude/qwen/pi） | codebuddy 无 herdr kind |

## 8. 前端改造（阶段 B，本次已落地）

1. ✅ 删除 xterm vendor（bundle 457KB → 70KB）与 `attachTerminal` 的 xterm 渲染；终端改为
   **TailView**：纯文本 `<pre>` + ANSI 剥离 + 缓冲区上限（compact 48KB / 详情 256KB），
   走同一 terminal WS（herdr 模式 = 后端 1.5s 轮询 `agent read`），根治长会话卡死
2. ✅ 列表按当前工作区过滤（沿用 `?cwd=` 的 list WS），头部显示 **herdr 宿主徽标**
   （`herdr v0.8.2` / 本地进程）+ 当前工作区对应的 **herdr 空间标签**（`空间 wD`）
3. ✅ 详情区 = 只读 tail + **发送框**（REST `/agents/{id}/send`，herdr 中执行）+ 操作按钮
   （压缩/清空/中断/关闭，中断改走 REST signal，因 herdr WS 忽略 signal 帧）
4. ✅ 新建弹窗：herdr 模式下引擎列表 = herdr kinds（claude/opencode/codex/qwen/pi），
   显示目标 herdr 空间状态（存在→复用；不存在→「创建时自动新建」）；角色预设/技能勾选保留
5. ✅ 后端新增 `GET /herdr/status`、`GET /herdr/workspace?cwd=`，`/config` 增加
   `herdrMode/herdrVersion/herdrKinds`；`HerdrAgentRegistry.findWorkspace()`（只查不建）；
   新建面板排版：面板数偶数→split right，奇数→split down（网格布局）

## 9. 实施阶段与验收

| 阶段 | 内容 | 验收 |
|------|------|------|
| **A（本次）** | adapter + registry + 接线（后端全通，侧边栏仍走 list WS） | ① `agent_list` 能看到 herdr 里开的智能体；② `agent_open` 在 herdr 面板起 opencode/claude 并注入简报；③ `agent_send`/`agent_read`/`agent_close` 全链路通；④ herdr 不可用时自动回退 legacy |
| **B** | 前端改造（删 xterm、只读 tail、分组、发送框） | 侧边栏无 xterm；长会话不卡 |
| **C（可选）** | CLI exec → herdr socket API 直连（JSON-RPC），轮询改事件推送 | 延迟更低、无子进程开销 |

### 阶段 A 实测记录（2026-08-29，herdr 0.8.2）

`plugin/test/herdr-e2e.mjs`（真实 opencode + 真实 herdr server）全链路通过：

1. **probe**：binary 发现（`~/.local/bin/herdr`）+ server 存活 + version 0.8.2 ✅
2. **create**：cwd 无 workspace 时自动 `workspace create`（wJ）→ `pane split` → `agent start opencode`（60s 就绪等待）→ 返回 handle ✅
3. **状态监控**：herdr `agent_status` 实时回流（idle → working）✅
4. **简报注入**：先 `agent wait --until idle/done/blocked` 再 `agent prompt --wait`，agent 终端完整收到「职责定义 + 团队协作协议」并执行（自主 `ls .deepseek/` 验证记忆目录）✅
5. **派活/收结果**：`agent prompt` 派测试任务 → agent 正确回复「收到测试指令，当前目录是 …」✅
6. **优雅关闭**：`/exit` → `agent wait` → `pane close`，agent 从 herdr 列表消失 ✅

踩坑记录（已修复）：
- herdr agent 条目的状态字段是 **`agent_status`** 而非 `status`（曾导致状态恒为 unknown）
- `agent prompt --wait` 在 agent **unknown/启动期**会触发 `agent_prompt_stalled` → 注入前必须先 `agent wait` 等到 idle/done/blocked
- 中文/大写名字违反 herdr 命名规则 `[a-z][a-z0-9_-]{0,31}` → 用 `a<8位hex>` 作 herdrName，展示名分离
- `agent wait --until` 可重复传多个状态（如 `--until idle --until done --until blocked`）

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| `agent start` 启动即 blocked（首启确认） | 返回 `AGENT_NOT_READY` 但保留名字 → `agentRead` 看弹窗 → `sendKeys` 确认 |
| 中文/大写名字违反 herdr 命名规则 | slug 化 + 随机后缀，展示名与 herdrName 分离 |
| codebuddy 无 herdr kind | herdr 模式明确报错；或 `herdr integration install` 后映射 |
| SIGTERM 无对应逻辑键 | 映射 ctrl+c 并注明；需要强杀时用 paneClose |
| herdr 进程退出 | probe() 失败 → 自动回退 legacy 模式，插件不失效 |
| 状态 `unknown` 误判 | 按 herdr 语义不视为完成；轮询加重试 |

## 11. 参考

- herdr 官方：https://herdr.dev/docs/ ｜ agent-guide：https://herdr.dev/agent-guide.md
- herdr agent SKILL：https://raw.githubusercontent.com/herdrdev/herdr/master/skills/herdr/SKILL.md
