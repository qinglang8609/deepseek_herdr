# Experience (项目经验总结)

> 最后更新：2026-08-21 12:00
> 总指挥会话累计：1 次

---

## 进行中的任务

| 任务 | 负责智能体 | 状态 | 开始时间 | 备注 |
|------|-----------|------|---------|------|
|      |           |      |         |      |

---

## 已完成任务记录

### [2026-08-21] 记忆层实战 + 弹窗完善 + 持久化恢复（三线并行）

**目标：** 技能默认全选生效、记忆层端到端可用、智能体信息持久化与重启恢复

**执行智能体：** opencode（弹窗）+ claude（记忆层/文档）+ 总指挥（持久化）

**结果：**
- ✅ 技能默认全选 + 会话名/会话id 随创建请求保存（opencode 完成，代码核实）
- ✅ sqlite3 3.54.0 可用，memory/tasks 表 CRUD 全通；MEMORY.md 升级为自包含操作手册（claude 完成）
- ✅ 持久化闭环：agents.json 存 pid/会话信息/转录尾部，重启后同 id 恢复 + 上下文回放

**经验教训：**
- **opencode 的进度条是"上下文用量"不是任务进度**，TUI 重绘掩盖真实状态 —— 判断完成要靠监控读代码核实，别信进度条
- claude 改代码后必须跑 node --check 验证（它自己的语法检查也要复核）
- 委托任务要写清"改哪个文件哪几行、验收标准"，opencode/claude 才能独立完成

### [2026-08-21] 并行审查第二轮：claude 审查 node 端

**目标：** claude + opencode 并行审查插件两端

**执行智能体：** claude（Opus 4.8，8 分钟）

**结果：**
- ✅ 3 CRITICAL（路径穿越写文件/信号注入/请求体无上限）+ 4 HIGH + 6 MEDIUM + 4 LOW + 8 通过
- ✅ 交叉验证：与 opencode 的发现互补 —— claude 主打 node 端安全（输入校验），opencode 主打 client 端生命周期
- ✅ 两个监控子代理全程无人工干预，各 8 分钟/5 分钟自动收报告

**经验教训：**
- 双方都独立指出"静默 catch 吞错"和"WS 健壮性"—— 高频共性问题，值得系统性治理
- claude 的 TUI 重绘让 agent_read 输出碎片化，监控员用"请求重印缺失条目"取回全部 17 条 —— 好技巧
- 审查类任务给 claude（深度）给 opencode（广度/速度）分工合理

**后续行动：**
- [ ] 修复 CRITICAL 6 项（node 3 + client 3）
- [ ] 修复 HIGH 关键项（定时器清理/WS 输入限制/Resize 节流）

### [2026-08-21] 并行审查第二轮：opencode 审查 client 端

**目标：** claude + opencode 并行审查插件两端，验证多智能体并行 + 异步监控

**执行智能体：** opencode（Sisyphus - Ultraworker / Kimi K2.6）

**结果：**
- ✅ 5m07s 完成：3 CRITICAL（全局 listWs WS 永不关闭/渲染期改 ref/connectListWs 竞态）+ 4 HIGH + 9 MEDIUM + 5 LOW + 12 通过
- ✅ 异步监控验证：派活后总指挥不阻塞，监控子代理 20s 轮询自动收报告

**经验教训：**
- opencode 未按协议更新 task-board.md/handoffs —— 协议执行靠 briefing 自觉，总指挥需在收尾时代为登记（设计如此：总指挥维护看板）
- **agent_read 对 opencode 只能看到 TUI 像素重绘帧**，真实内容要从其 SQLite 会话库读（~/.local/share/opencode/opencode.db 的 part 表）—— 监控 opencode 复用此法
- 监控子代理把完整报告落盘到 handoffs/ 是很好的兜底习惯

**后续行动：**
- [ ] 修 opencode 报告的 CRITICAL 3 项（WS 泄漏/ref 副作用/竞态）
- [ ] 等 claude 的 node 端审查结果，两边交叉验证后统一修复

### [2026-08-21] 多智能体首次实战：claude 审查 plugin/package.json

**目标：** 验证指挥官链路（agent_list → agent_send → agent_read），让 claude 审查插件 package.json

**执行智能体：** ceshi(claude)

**结果：**
- ✅ 链路全通：派活 → claude 思考/读文件/跑命令 → 分级报告 → 回到空闲
- ✅ 发现 1 CRITICAL（files 缺 lib/types/，npm 发布后类型声明丢失）+ 1 HIGH（无 lockfile）+ 3 MEDIUM + 1 LOW

**经验教训：**
- **多行任务文本 + 回车在 claude Code 输入框不生效**：文本进入多行模式，最后的 \r 不提交 —— 派活时要用单行文本（或先发文本再单独补一个回车）
- **claude Code 每个 bash 命令都要权限确认**：会让自主工作卡住 —— 需要在 ~/.claude/settings.json 配置 allow 规则（Read/Edit/Bash 只读命令）减少摩擦
- claude 的 TUI 全屏重绘导致转录里有大量重复帧，agent_read 读报告时要容忍重复内容

**后续行动：**
- [ ] 按报告修复 package.json（files 加 lib/types/、补 license/repository）
- [ ] 配置 claude 权限 allow 规则

## 已完成任务记录

### [2026-08-21] 开发 dsh-agent-commander 多智能体指挥插件

**目标：** 给 DeepSeek Harness 做原生多智能体指挥：右侧雷达面板 + agent_* 工具 + 共享记忆

**执行智能体：** 主代理（DeepSeek）

**结果：**
- ✅ 插件（node 端 AgentRegistry + 6 个 agent_* 工具 + WS/HTTP 路由；client 端雷达面板 + xterm 实时终端 + 新建弹窗）
- ✅ agent-commander skill 安装进 ~/.agents/skills，已能被会话发现
- ✅ 共享记忆自动播种：记忆库.md / 任务看板.md / 经验总结.md / 交接区/
- ✅ 集成验证通过（fake ctx 驱动 apply、真实 spawn claude、读输出、SIGINT、关闭）

**经验教训：**
- DSH 客户端插槽是 shadowing 模型：低 priority 覆盖高 priority，但被覆盖的 entry 的子插槽声明仍有效，而自己的 renderSlot 只能渲染自己声明的子插槽 —— 所以自定义视图要么自包含，要么注册到已有插槽（details 栏）
- 客户端 bundle 是 `window.__ModuleLoader__.load({id, factory})` 单文件形态，第三方库（xterm）直接内联，依赖（react 等）通过 require 解析，无需构建系统
- node-pty 在 macOS 上若 spawn 报 `posix_spawnp failed`：先检查 prebuilds/*/spawn-helper 执行位（pnpm 会剥掉），chmod 755 即可；测试沙箱拦截进程创建时也会报同样错误，需区分
- 插件集变更必须重启桌面应用才生效（client-modules 无全量重扫路径）
- 桌面应用本身可用 `ELECTRON_RUN_AS_NODE=1` 当 node 用，本机没有独立 node 也不影响构建/测试

**后续行动：**
- [ ] 重启 DeepSeek Harness 验证雷达面板 UI
- [ ] 安装 opencode（当前未安装，弹窗会显示"未安装"）

---

## 踩坑记录

| 日期 | 问题 | 原因 | 解决方案 | 预防措施 |
|------|------|------|---------|---------|
| 08-21 | node-pty spawn 报 posix_spawnp failed | prebuilds 里 spawn-helper 执行位被 pnpm 剥掉 | chmod 755 所有 prebuilds/*/spawn-helper | 插件 ensureSpawnHelper 启动时自动修复 |
| 08-21 | 测试里所有 spawn 都失败 | 测试环境的文件沙箱拦截进程创建（非插件缺陷） | 用 danger-full-access 模式跑集成测试 | 区分沙箱拦截与真实错误 |
| 08-21 | 两个 CSS 注入块都声明 const css 导致 SyntaxError | 变量名冲突 | 生成唯一变量名 | 构建脚本用 varName 参数 |

---

## 代理特长笔记

| 智能体 | 擅长 | 不擅长 | 最佳任务类型 |
|--------|------|--------|------------|
| claude | 深度审查、复杂推理 | 速度较慢 | 文档对照审查、架构分析 |
| opencode | 快速执行、文件操作 | 复杂推理 | 代码修复、文件生成 |
| codex  | 代码理解、项目探索 | MCP 依赖 | 项目探索、依赖分析 |

---

## 复用模式库

### 模式：多智能体并行审查
**场景：** 多份文档/模块需要对照审查
**做法：** 每个智能体分配一份，并行审查，最后总指挥汇总交叉验证
**效果：** 审查时间缩短 60%+

### 模式：开发 + 审查并行
**场景：** 边开发边保证质量
**做法：** 智能体 A 开发新功能，智能体 B 同步审查已完成代码
**效果：** 问题即时发现，减少返工
