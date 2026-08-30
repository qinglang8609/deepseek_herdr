# dsh-agent-commander — 任务 / 演进记录

> 当前分支：main（v0.4.0 已发布：commit 16bf783 + tag v0.4.0，双远端已推送）。

## 当前架构决定（v0.4 方向）

- **herdr 已整体移除**：删除 `plugin/lib/herdr-adapter.js`、`herdr-registry.js`、`composite-registry.js` 及测试 `plugin/test/herdr-e2e.mjs`（它仍 import 已删除的 herdr 模块，无法运行）；宿主统一为 **node-pty 网页终端**（`index.js` 内联 `AgentRegistry` 直接 `node-pty` spawn，无 agentHost 切换字段）。
- **默认宿主 = node-pty 网页终端**（`index.js` 内联 `AgentRegistry` 直接 node-pty spawn；曾新增的 `plugin/lib/pty-registry.js`、`log.js` 未被 index.js 接入，已在本轮清理中删除）：node-pty 拉起子进程，handle 带 `.pty` + `.transcript`；create 自动应答启动弹窗 + 注入/验证角色简报；`agent_read` 返回真实终端输出。
- **雷达两段独立展示**：
  - **运行中** = 当前开着的终端（来自 `/agents` 实时列表，node-pty 活跃进程；新开 agent 无会话 ID 也立刻显示）。点开 → xterm 终端小窗（`/agent-commander/ws/terminal` 流式）。
  - **会话历史** = 纯历史（`session-scanner` 四引擎 + `session-monitor` 巡检 + `/sessions` 恢复/删除）。运行中的窗口只在匹配的历史行上标 `running`；未命中历史会话的运行窗口合成精确 `live:` 卡片（引擎写入首条消息后自动消失）。

## 待办 / 下一步

- [ ] 真机验证（重启 DSH）：node-pty 新建 → 自动启动确认 + 简报注入验证落地；点开「运行中」→ xterm 小窗实时输出；新建但未说话的 agent 即时入「运行中」；历史恢复/删除。
- [ ] 验证 `/agent-commander/ws/terminal` 终端流（input/resize/signal/close）与「非详情页不流式渲染」的省内存设计。
- [x] 清理文档遗留引用：`docs/terminal-host-dev.md` / `docs/herdr-integration-dev.md` 已删除，确认 README / plugin/README 无指向这些文件的失效链接（README 已同步去除 herdr 章节，plugin/README 无引用）。✅ 已核对（commit 9cd8dbc 工作区）：README / plugin/README 无对已删文档的失效链接（仅 README 版本历史叙述性提到 `docs/` 被移除，非链接；plugin/README 的 `docs/user/...` 为外部官方文档 URL）；plugin/ 下无 .md 或注释残留引用。
- [x] 发布 v0.4（`node scripts/release.mjs patch`；发布前先 `pnpm approve-builds` 放行 node-pty）。✅ 已发布 v0.4.0：build client 471785B + npm pack 回退正常；commit 16bf783 + tag v0.4.0；已推送 git.d8gx.com 与 github 双远端。tarball `dist/dsh-agent-commander-0.4.0.tgz`。

## 开启/注入简报→启动完成 流程优化（用户反馈：codex 点 yes 退出 / opencode 偶发退出）

> 根因：monitorTick 用一套全局正则（去空格匹配 `norm`）+ 静默/宽限启发式，跨引擎误判误答；`approve()` 一律写「1」+\r 适配不了 codex 的 `[y/N]`/`Proceed?` 类 yes-no；opencode 双 Ctrl+C 退出且启动中持续重绘，裸 Enter/重试易打进脆弱窗口。

- [x] **P0** `approve()` 引擎感知：读当前 `pendingApproval`（prompt/engine）+ 转录，按引擎+弹窗类型选正确键序（yes/no→`y`+\r；编号菜单→读选项列表再发对应数字；识别不出→把选项抛给用户 `agent_approve`）。不再无脑发「1」。✅ 已改（index.js）：新增 `_approvalKey()`，pendingApproval.answerType==="yes_no" → choice 归一化为 `y`/`n`；无挂起时用 `stripAnsi` 转录尾判断 y/n 还是编号菜单。待重启 DSH 实测 codex。
- [x] **P0** codex 启动配方：信任目录/onboarding 类提示自动答 `y`+\r（当前被 `enter:true` 一刀切按回车，方向错）；其余不确定提示 → hold 上报用户。✅ 已改（index.js）：信任目录 pattern 拆出独立，加 `engineKeys:{codex:["y","\r"]}`，answerPrompts 按引擎写键；非 codex 维持回车。待重启 DSH 实测。
- [x] **P1** opencode 加固：启动期绝不发 `\x03`/Ctrl+C；仅当确认的 `Ask anything` 真提示符才 inject；`pressEnter` 重试限定为「转录未增 且 真提示符仍在」才补 Enter，且已有 `reacted` 即停。✅ 核查：opencode 路径本就排除裸 Enter 重试（走 db 校验+整段重写）、inject 仅在 `Askanything` 真提示符时触发、monitor 启动期无 Ctrl+C；本轮 `_attachPty` 启动期崩溃自动重开进一步兜底。注：opencode「运行中偶退」超出启动监控范畴，若复现需单独排查（非本监控 bug）。
- [x] **P1** 启动期崩溃自动重试：简报确认前 `pty` 退出 → 保留 `briefing/role/skills` 自动重启一次并重跑 monitor；超次明确报错并挂起。✅ 实现：`create()` 抽出 `_attachPty()`（create/_respawn 共用），onExit 判定 bootCrash（phase=boot、未 reacted、briefing=pending、未重试、有输出）→ `_respawn()` 一次（上限 1 次，用户主动 close 经 phase=exit 已排除，秒退无输出不重开）。
- [x] **P2** 按引擎 `BOOT_SPELL` 状态机替代全局正则+静默启发式：每步 `{match, keys, action:'auto'|'hold'|'inject'}`，只对「该引擎确认为安全」的启动提示自动答。✅ 改造成按引擎提示白名单 `PER_ENGINE_PROMPTS`（claude/codex/codebuddy/opencode/default，每引擎独立 `keys`+`once`/`critical`）+ 按引擎可注入标记 `PER_ENGINE_READY_RE`（opencode/claude 需真实提示符，其余用静默）。引擎级提示/就绪已达成，未用逐字符脚本化状态转换。
- [x] **P2** 匹配改用保留标点的 `clean` + 锚定/词边界，避免跨引擎误命中。✅ 已引擎作用域（跨引擎误命中已消除）+ 只匹配最近 ~600 字符转录尾（近端锚定，避免早期回显重复误答）；`clean` 保留标点匹配随引擎白名单一并落地。
- [x] **P2** 加 `monitor` 调试日志（engine/phase/action/命中 sig/写入键/转录增量），出问题看日志定位。✅ `_monLog()`，经 `DSH_AGENT_MONITOR_DEBUG=1` 开启；在 start/inject/press-enter/finish/approve-key 打点。

## 已完成的 v0.4 改动（本次工作区）

- [x] 新增 `plugin/lib/session-monitor.js`；`pty-registry.js` / `log.js` 曾新增但未被 index.js 接入，本轮清理已删除。
- [x] `index.js`：内联 `AgentRegistry` 直接 `node-pty` spawn（去掉 agentHost 切换、去掉 herdr/composite）；新增 `/agent-commander/ws/terminal` 终端流 WS + `attachTerminal`（`pty.onData`→ws，input/resize/signal/close 写回）；系统提示改 node-pty 描述。
- [x] `session-monitor.js`：`buildSessionList` 历史只做 running 精确标注；未命中历史会话的运行窗口合成精确 `live:` 卡片。
- [x] 客户端 `plugin/src/client/`：恢复 vendored `xterm.inline.js`+`xterm.css`；`build-client.mjs` 注入 xterm；新增 `AgentTerminal`（xterm+WS 终端小窗，仅详情页创建）；`TerminalDetail` 改用 xterm；雷达改两节 `RunningSection`（运行中）+ `SessionsSection`(会话历史)。
- [x] `plugin/lib/client.js` 重建（471019 字节，含 vendored xterm）。
- [x] 删除 herdr 三件套；`plugin/README.md` Config 表已同步（无 agentHost 字段，herdr 宿主描述已移除）。
- [x] 全部 lib 模块 `node --check` 通过；pty 注册表方法面 smoke test 通过。

## 真机验证发现的 bug（待修，用户反馈）

- [x] 新建智能体没有注入提示词（`plugin/src/client/app.js` 创建流程：新建后角色/技能简报未生效）。✅ 代码已修：`index.js` create() 恒置 `briefing:"pending"` 并空角色兜底文案；新增 `markBriefingSent()` 在简报确认着陆（`_briefingLandedInFile`/opencodeBriefingLanded/引擎回显）时立刻置 `sent`。待重启 DSH 真机验证。
- [x] 会话历史没有显示当前会话的卡片：新建智能体时若未对话，无会话缓存，卡片不出现。✅ 代码已处理：node 端 `buildSessionList` 对未命中历史会话的运行窗口合成 `live:` 卡片；客户端 `briefingDone`→`refreshSessions` 及时拉取。待重启 DSH 真机验证。
- [x] 会话历史与窗口未绑定：在 claude 里说句话刷新后，历史已有会话卡片但不显示「正在运行中」。✅ `sessionCacheId`（运行窗口按创建后新落盘会话文件发现）与 `buildSessionList` 精确匹配 `sess.id`，标 running。待重启 DSH 真机验证。
- [x] 会话历史点击恢复失败：`Cannot read properties of undefined (reading 'claude')`，不能恢复对话。✅ 已修复（commit 9cd8dbc）：restoreSession 里 `this.binaries[engine]` 因构造函数未初始化 this.binaries 而抛错，改用与 create() 一致的 `resolveBinary(engine)`；重启 DSH 生效。
- [x] 智能体卡片上去掉 `#55576 · ws:7cfb4590-...` 这类无用信息显示。✅ 已删除卡片上这段 `dhac_agentMeta`（app.js）。
- [x] 智能体上面的刷新按钮点击执行的是 `/clear` 命令而不是 `/refresh` 命令。✅ 卡片与详情栏：新增「刷新会话历史」（refresh-cw→refreshSessions），「清空会话历史」改为 trash 图标并明确文案（/clear 或 /new）；详情栏 `AgentCards.onRefresh` 已接线。
- [x] 新建智能体时，简报注入 明明已经成功了 但是还是显示 等等启动就绪自动回车执行。✅ `markBriefingSent()` 在简报确认着陆即置 `sent`，客户端 `setAgentsState` 刷新后显示消失。
- [x] 完善todo.md 更新文件。✅ 本轮已更新。
- [x] 智能体窗口的终端运行时间长了会比较卡，影响使用，要优化一下长时间使用后。✅ 已做省资源优化：MiniTerminal scrollback 2000→800、写按帧合并节流（16ms 一次 term.write）、cleanup 清 timer。待重启 DSH 观察实际效果。
