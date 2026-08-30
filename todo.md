# dsh-agent-commander — 任务 / 演进记录

> 当前分支：feat/terminal-host（工作区已含 v0.4 方向改动，未提交、未发布）。

## 当前架构决定（v0.4 方向）

- **herdr 已整体移除**：删除 `plugin/lib/herdr-adapter.js`、`herdr-registry.js`、`composite-registry.js` 及测试 `plugin/test/herdr-e2e.mjs`（它仍 import 已删除的 herdr 模块，无法运行）；宿主统一为 **node-pty 网页终端**（`index.js` 内联 `AgentRegistry` 直接 `node-pty` spawn，无 agentHost 切换字段）。
- **默认宿主 = node-pty 网页终端**（`index.js` 内联 `AgentRegistry` 直接 node-pty spawn；曾新增的 `plugin/lib/pty-registry.js`、`log.js` 未被 index.js 接入，已在本轮清理中删除）：node-pty 拉起子进程，handle 带 `.pty` + `.transcript`；create 自动应答启动弹窗 + 注入/验证角色简报；`agent_read` 返回真实终端输出。
- **雷达两段独立展示**：
  - **运行中** = 当前开着的终端（来自 `/agents` 实时列表，node-pty 活跃进程；新开 agent 无会话 ID 也立刻显示）。点开 → xterm 终端小窗（`/agent-commander/ws/terminal` 流式）。
  - **会话历史** = 纯历史（`session-scanner` 四引擎 + `session-monitor` 巡检 + `/sessions` 恢复/删除）。运行中的窗口只在匹配的历史行上标 `running`；未命中历史会话的运行窗口合成精确 `live:` 卡片（引擎写入首条消息后自动消失）。

## 待办 / 下一步

- [ ] 真机验证（重启 DSH）：node-pty 新建 → 自动启动确认 + 简报注入验证落地；点开「运行中」→ xterm 小窗实时输出；新建但未说话的 agent 即时入「运行中」；历史恢复/删除。
- [ ] 验证 `/agent-commander/ws/terminal` 终端流（input/resize/signal/close）与「非详情页不流式渲染」的省内存设计。
- [ ] 清理文档遗留引用：`docs/terminal-host-dev.md` / `docs/herdr-integration-dev.md` 已删除，确认 README / plugin/README 无指向这些文件的失效链接（README 已同步去除 herdr 章节，plugin/README 无引用）。
- [ ] 发布 v0.4（`node scripts/release.mjs patch`；发布前先 `pnpm approve-builds` 放行 node-pty）。

## 已完成的 v0.4 改动（本次工作区）

- [x] 新增 `plugin/lib/session-monitor.js`；`pty-registry.js` / `log.js` 曾新增但未被 index.js 接入，本轮清理已删除。
- [x] `index.js`：内联 `AgentRegistry` 直接 `node-pty` spawn（去掉 agentHost 切换、去掉 herdr/composite）；新增 `/agent-commander/ws/terminal` 终端流 WS + `attachTerminal`（`pty.onData`→ws，input/resize/signal/close 写回）；系统提示改 node-pty 描述。
- [x] `session-monitor.js`：`buildSessionList` 历史只做 running 精确标注；未命中历史会话的运行窗口合成精确 `live:` 卡片。
- [x] 客户端 `plugin/src/client/`：恢复 vendored `xterm.inline.js`+`xterm.css`；`build-client.mjs` 注入 xterm；新增 `AgentTerminal`（xterm+WS 终端小窗，仅详情页创建）；`TerminalDetail` 改用 xterm；雷达改两节 `RunningSection`（运行中）+ `SessionsSection`(会话历史)。
- [x] `plugin/lib/client.js` 重建（471019 字节，含 vendored xterm）。
- [x] 删除 herdr 三件套；`plugin/README.md` Config 表已同步（无 agentHost 字段，herdr 宿主描述已移除）。
- [x] 全部 lib 模块 `node --check` 通过；pty 注册表方法面 smoke test 通过。

## 真机验证发现的 bug（待修，用户反馈）

- [ ] 新建智能体没有注入提示词（`plugin/src/client/app.js` 创建流程：新建后角色/技能简报未生效）。
- [ ] 会话历史没有显示当前会话的卡片：新建智能体时若未对话，无会话缓存，卡片不出现。
- [ ] 会话历史与窗口未绑定：在 claude 里说句话刷新后，历史已有会话卡片但不显示「正在运行中」。
- [ ] 会话历史点击恢复失败：`Cannot read properties of undefined (reading 'claude')`，不能恢复对话。
- [ ] 智能体卡片上去掉 `#55576 · ws:7cfb4590-...` 这类无用信息显示。
- [ ] 智能体上面的刷新按钮点击执行的是 `/clear` 命令而不是 `/refresh` 命令。