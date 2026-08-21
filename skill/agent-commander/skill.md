---
name: agent-commander
description: 多智能体总指挥方法论（DSH 原生版）— 用 agent_open/agent_list/agent_read/agent_send/agent_signal/agent_close 打开并指挥 claude / opencode / codex / codebuddy / pi / qwen 团队，通过 .deepseek/memory.md / task-board.md / experience.md / handoffs/ 共享记忆与任务进度，分工审查、修复、验证，实现高效任务编排
---

# 多智能体总指挥方法论（Agent Commander Pattern）

## 核心理念

**一个上下文，多个执行者。** 你是总指挥，不直接干活，而是通过 DSH 原生工具编排多个 AI 智能体并行执行任务：打开智能体（claude / opencode / codex / codebuddy / pi / qwen）、派活、读结果、汇总决策。所有智能体共享同一个工作目录 —— .deepseek/ 下的记忆库、任务看板、经验总结、交接文件都在文件系统里，天然共享。

## 适用场景

- 大型代码审查（多模块并行审查）
- 多文件修复（互不依赖的 bug 并行修复）
- 文档对照验证（多个文档 × 多个模块）
- 项目探索（多个智能体从不同角度分析）
- 迭代开发（一个智能体开发，一个智能体审查）

## 第一步：侦察 — 了解战场

```text
agent_list      # 查看当前有哪些智能体在线（id / 引擎 / 名称 / 角色 / 状态）
```

建立智能体清单：

| 智能体 id | 引擎 | 名称 | 角色 | 状态 |
|-----------|------|------|------|------|
| a1b2c3d4 | claude | 审查官 | 代码审查专家 | idle |
| e5f6a7b8 | opencode | 修复员 | 前端专家 | working |

开工前先读团队上下文：

```text
1. agent_read <审查官id>            # 看最近输出，判断在干什么
2. 用 read 工具读工作目录 .deepseek/ 下的 memory.md 和 task-board.md（如存在）
```

## 第二步：分工 — 开智能体 + 因材派活

### 打开新智能体（带角色定义和技能）

```text
agent_open type="claude" name="数据库审查官" role="你负责数据库设计与 SQL 优化，精通 PostgreSQL，独立完成表结构评审与慢查询分析" skills=["/Users/<你>/.agents/skills/karpathy-guidelines/skill.md"] cwd="<工作目录>"
```

- **type**：claude / opencode / codex（未安装的会报错，先 `agent_list` 或面板确认）
- **role**：角色定义，会被注入为该智能体的开场简报（例：数据库专家、设计专家、前端专家、测试专家、代码审查专家、架构师）
- **skills**：挂载技能文件路径（`~/.agents/skills/<名称>/skill.md`），该智能体开工前必读
- 角色与技能决定分工：Claude 做深度审查，OpenCode 做快速修复，Codex 做项目探索

### 分工原则

1. **独立任务并行分配** — 互不依赖的任务分给不同智能体
2. **按特长分配** — 深度审查给 Claude，快速修复给 OpenCode
3. **上下文隔离** — 每个智能体只接收它需要的信息
4. **任务粒度适中** — 太粗则智能体迷失，太细则通信开销大

### 指令三要素

```
好的指令：
"请读取'会员等级价格开发文档.md'，然后对照开发文档审查前面开发的功能
是否完善，检查是否有遗漏或未完成的项，列出审查结果。"

差的指令：
"检查一下代码"  ← 太模糊
```

1. **输入** — 读取什么文件/数据
2. **动作** — 做什么（审查/修复/探索/对比）
3. **输出** — 期望的结果格式（列表/表格/报告）

## 第三步：监控 — 等待结果

### 3.1 派活（重要：单行文本！）

```text
agent_send <id> text="<任务描述>" submit=true
```

⚠️ **多行文本会让 claude 的输入框进入多行模式，最后的回车不提交** —— 派活时把任务
写成**单行**（换行用空格代替），或先发文本、再单独补发一个空 submit=true 回车。

### 3.2 异步监控（推荐 —— 不阻塞总指挥）

**派活后不要自己 sleep 轮询占用回合**。用后台子代理（subagent 工具，run_in_background）
去盯结果，总指挥立刻回到主对话继续接别的任务：

```text
你（总指挥）派活 → 启动一个后台监控子代理 → 继续干别的
监控子代理：每 15-20 秒 agent_read 一次 → 识别完成标记 → 把最终输出整理成报告返回
完成后系统会通知你（监控子代理的报告）
```

监控子代理的指令模板（自包含，含工具说明）：
"你是任务监控员。用 agent_read 工具轮询智能体 <id> 的输出（每次间隔 15-20 秒），
任务描述：<单行>。识别完成标记：`✻ Worked` / 回到 `❯` 提示符 / 出现汇报总结。
完成后用 agent_read bytes=8000 抓取最终输出，去掉 TUI 重复帧，整理成结构化的
完成报告返回；超时（如 10 分钟）未完成则返回当前进展。"

### 3.3 手动轮询（简单任务）

```
派活 → 等 15-20 秒 → agent_read → 判断是否完成 → 未完成继续轮询
```

### 3.4 识别智能体状态（面板徽标 + 输出特征）

| 状态 | 输出特征 | 操作 |
|------|---------|------|
| working | 思考动词（`Thinking`/`Forming`/`Brewing`/`Reading` 等）、旋转指示器（⠸/✶/✻ 等）、页脚 `esc to interrupt` | 等待，稍后读输出 |
| idle | `✻ Worked for Xm` / `Welcome back` / 页脚 `? for shortcuts` / `❯ Try` 提示 | 可以下发新任务 |
| exited | 进程已退出 | `agent_open` 重新打开 |

> ⚠️ claude 底部常驻的 `⏸ manual mode on` 是**正常空闲提示**，不是受阻 —— 不要据此判定
> blocked。判断"受阻"要读终端内容：出现等待确认的提问（如权限询问）时，要么直接在
> 面板终端里确认，要么 `agent_send <id> text="y" submit=true` 应答，或
> `agent_signal signal="SIGINT"` 中断后重派。

## 第四步：汇总 — 交叉验证

```text
agent_read <审查官id> bytes=20000
agent_read <修复员id> bytes=20000
```

### 汇总原则

1. **保留原始结论** — 不要篡改智能体的审查结果
2. **交叉验证** — 两个智能体审查同一类问题时对比结论
3. **分级整理** — 按严重程度（CRITICAL > HIGH > MEDIUM > LOW）排列
4. **标注状态** — ✅ 已完成 / ⚠️ 需关注 / ❌ 未完成 / 🔄 修复中

## 第五步：迭代 — 修复与验证

```text
# 将审查发现的问题整理成修复清单，发给执行智能体
agent_send <修复员id> text="请修复以下问题：
1. 问题描述 — 具体修复要求
2. 问题描述 — 具体修复要求
请逐一修复，每完成一项汇报进度。" submit=true
```

闭环验证：审查（A）→ 发现问题 → 修复（B）→ 验证（A 或 C）→ 完成

## 第六步：共享记忆与任务进度协议（团队协作的命脉）

> **所有智能体工作在同一目录，文件系统即共享大脑。总指挥负责维护协议。**

### 6.1 四份共享资产

| 文件 | 内容 | 谁读写 |
|------|------|--------|
| `.deepseek/memory.md` | 长期记忆：项目事实、决策记录、代理特长 | 全员读写，总指挥汇总 |
| `.deepseek/task-board.md` | 任务 → 负责人 → 状态(🔄/✅/❌) → 结果 | 派活时登记，收尾时更新 |
| `.deepseek/experience.md` | 工作经验沉淀：结果、经验教训、踩坑记录、复用模式 | 每个阶段/任务结束时写 |
| `.deepseek/handoffs/` | 智能体之间的手递手文件（`handoffs/<名称>-<主题>.md`） | 异步协作时用 |

> 开智能体时插件会自动在工作目录播种这四份资产（已存在则不覆盖）。

### 6.2 协议规则（必须执行）

1. **派活时**：在 `.deepseek/task-board.md` 登记任务（负责人、状态 🔄、开始时间）
2. **收尾时**：智能体完成后，总指挥更新看板状态为 ✅/❌ 并写明结果摘要
3. **交接时**：A 的产出写入 `.deepseek/handoffs/`，再派 B 去读取，避免重复传达
4. **总结时**：每个阶段/任务结束，把经验写入 `.deepseek/experience.md`（结果、教训、踩坑、复用模式）
5. **沉淀时**：新踩坑、新发现写入 `.deepseek/memory.md`（日期 + 问题 + 原因 + 解法）
6. **会话开始**：先读 `.deepseek/memory.md` + `task-board.md` + `experience.md`，回顾上下文与历史经验
7. **会话结束前**：更新看板中的进行中任务状态

### 6.3 任务看板模板（`.deepseek/task-board.md`）

```markdown
# Task Board

| 任务 | 负责人 | 状态 | 开始时间 | 结果 |
|------|--------|------|---------|------|
| 会员等级价格功能审查 | 审查官(claude) | ✅ | 08-20 10:00 | 30 模块全部通过 |
| 预售商品功能审查 | 修复员(opencode) | 🔄 | 08-20 10:05 | 发现 3 个问题修复中 |
```

### 6.4 经验总结模板（写入 `.deepseek/experience.md`）

```markdown
## 已完成任务记录

### [2026-08-20] 会员等级价格 + 预售商品并行审查

**目标：** 对照两份开发文档，审查项目实现完整性

**执行智能体：** 审查官(claude) + 修复员(opencode)

**结果：**
- ✅ 会员等级价格：30 个模块全部通过
- ⚠️ 预售商品：核心逻辑完整，定时任务缺失
- ❌ 回归测试未覆盖

**经验教训：**
- Claude 擅长深度审查但较慢，OpenCode 擅长快速定位缺失
- 并行审查不同文档比串行高 2 倍以上

## 踩坑记录

| 日期 | 问题 | 原因 | 解决方案 | 预防措施 |
|------|------|------|---------|---------|
| 08-20 | agent_send 后读不到输出 | 智能体还在思考 | 轮询 agent_read | 派活后等 15-20s 再读 |
```

## 第六步补充：SQLite 记忆层（共享记忆的核心）

团队知识库是项目根 **`.deepseek/memory.db`**（SQLite），所有智能体（claude/opencode/
codex/DeepSeek）都能读写 —— 记忆跨会话、跨智能体持久共享。用法文档在
`.deepseek/MEMORY.md`（开智能体时自动生成），要点：

```bash
# 读（开工前）
sqlite3 .deepseek/memory.db "SELECT id,namespace,title,substr(body,1,200) FROM memory ORDER BY id DESC LIMIT 20;"
sqlite3 .deepseek/memory.db "SELECT * FROM tasks WHERE status != '✅';"

# 写（收尾/学到东西时）
sqlite3 .deepseek/memory.db "INSERT INTO memory (namespace,title,body,tags,source) VALUES ('experience','标题','内容','标签','<名字>');"
sqlite3 .deepseek/memory.db "UPDATE tasks SET status='✅', result='结果' WHERE id=<任务id>;"
sqlite3 .deepseek/memory.db "INSERT INTO handoffs (from_agent,to_agent,subject,body) VALUES ('<名字>','','主题','内容');"

# 搜索
sqlite3 .deepseek/memory.db "SELECT * FROM memory WHERE body LIKE '%关键词%' OR tags LIKE '%关键词%' ORDER BY id DESC LIMIT 10;"
```

规则：只 INSERT/UPDATE/SELECT，绝不 DROP/ALTER；长报告写 `.deepseek/handoffs/`。
DeepSeek 总指挥也有 mem_query / mem_add 工具直接读写。

## 标准 API（window.dshAgentCommander）

插件在浏览器暴露统一 JS API（其他插件/脚本可直接调用）：
`list()` / `open(opts)` / `send(id,text,submit)` / `read(id,bytes)` / `approve(id,choice)` /
`signal(id,signal)` / `close(id,graceful)` / `status(id)` / `memory.list|search|add` /
`onStatus(listener)`。对应 REST：`GET /agent-commander/api/agents`、`POST .../agents/:id/send`
等。模型侧对应 agent_* 工具。

## 第七步：总结 — 经验沉淀

**每个阶段结束时必须总结，下次开始前必须回顾。** 总结写入 `.deepseek/experience.md`（结构见 6.4），
长期知识与代理特长汇总进 `.deepseek/memory.md`。

好的总结：
```markdown
### [2026-08-20] 会员等级价格 + 预售商品并行审查

**目标：** 对照两份开发文档，审查项目实现完整性

**结果：**
- ✅ 会员等级价格：30 个模块全部通过
- ⚠️ 预售商品：核心逻辑完整，定时任务缺失

**经验教训：**
- Claude 擅长深度审查但较慢，OpenCode 擅长快速定位缺失
- 并行审查不同文档比串行高 2 倍以上

**踩坑：**
- agent_send 派活后需轮询 agent_read，别指望一次读完
- claude 底部常驻 `⏸ manual mode on` 是空闲提示不是受阻；真正等待确认时读终端内容判断
```

## 工具速查

```text
agent_open    type=<claude|opencode|codex|codebuddy|pi|qwen> name=? role=? skills=? cwd=?  # 开智能体
agent_list                                                               # 看在线智能体
agent_read   id=? bytes=?                                               # 读最近输出
agent_send   id=? text=? submit=true|false                              # 派活/发消息
agent_approve id=? choice=?                                             # 确认弹窗（默认选1=Yes）
agent_signal id=? signal=SIGINT|SIGTSTP|SIGTERM                        # 中断/暂停
agent_close  id=?                                                       # 关闭智能体
mem_query    query=? namespace=? limit=?                                # 查记忆库(SQLite)
mem_add      title=? body=? namespace=? tags=?                          # 写记忆库(SQLite)
```

## 注意事项

1. **不要过度并行** — 3-4 个智能体是舒适区，太多难以监控
2. **指令要具体** — 模糊指令导致智能体做无用功
3. **及时读输出** — 智能体输出有缓冲区限制，长时间不读可能丢失
4. **保持上下文一致** — 所有智能体的工作目录应相同（同一项目）
5. **记录决策过程** — 审查报告不仅是结果，也是决策依据
6. **用户可旁观** — 右侧「智能体雷达」面板实时显示每个智能体的输出和状态，用户也能直接打字给智能体
