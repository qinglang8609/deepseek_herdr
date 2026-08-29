
---

## herdr 集成迁移（feat/herdr-adapter 分支）

- [x] 能力对照：herdr 覆盖创建/监控/状态/下命令/回车，claude+codex+opencode 集成已装
- [x] 开发文档 docs/herdr-integration-dev.md（架构、概念映射、模块设计、风险）
- [x] plugin/lib/herdr-adapter.js —— herdr CLI 封装（binary 发现/probe/JSON 信封/错误分类/超时）
- [x] plugin/lib/herdr-registry.js —— 注册表门面（同接口：create/list/read/send/approve/signal/close/compact + 轮询）
- [x] lib/index.js 接线 —— Config.agentHost(auto/herdr/legacy) + 构造器双宿主 + tools/API/WS async 化 + herdr 只读 tail 终端
- [x] E2E 全链路通过（test/herdr-e2e.mjs）：workspace 自动创建 → split → agent start → 简报注入 → 状态流转 → 派活 → 收结果 → 优雅关闭
- [ ] 前端改造（阶段 B）：删 xterm、只读 tail + 发送框、workspace 分组、新建弹窗引擎改 herdr kinds
- [ ] herdr-commander skill 沉淀（herdr 命令 + 记忆协议封装）
- [ ] 重启 DSH 后真机验证 agent_* 工具 + 侧边栏（需重新构建插件 client 并安装）

### herdr 集成（续，feat/herdr-adapter 分支第二阶段）
- [x] 后端：/herdr/status + /herdr/workspace API、/config 增加 herdrMode/herdrVersion/herdrKinds
- [x] HerdrAgentRegistry.findWorkspace()（只查不建）+ 新建面板交替排版（right/down 网格）
- [x] 前端：TailView 纯文本只读 tail 替代 xterm（bundle 457KB→70KB）、详情发送框、
      SIGINT 改 REST、herdr 宿主徽标 + 当前工作区 herdr 空间标签
- [x] 新建弹窗：herdr kinds 引擎列表 + herdr 空间状态提示（不存在自动新建）
- [x] 清理：移除 xterm vendor 与死 CSS、删除 test/herdr-debug.mjs、tgz 产物改 dist/(gitignore)
- [x] 发布流程：scripts/release.mjs（构建→升版本→pack→commit+tag→清单；pnpm 失败回退 npm）
- [ ] 重启 DSH 真机验证：侧边栏 herdr 徽标/空间标签/新建流程/只读 tail + 发送框
- [ ] 合并 feat/herdr-adapter → main，`node scripts/release.mjs patch` 发布 v0.2.3

---

## 终端宿主模式（feat/terminal-host 分支，v0.3 方向）
- [x] P1：terminal-launcher（open 拉起 Terminal/Ghostty/iTerm + pidfile 捕获 PID，已验证）
      + process-monitor（kill -0 存活）+ keystroke（System Events 按键注入）
- [x] P1：terminal-registry（create 拉起→2s 轮询灰/绿；send/approve 按键；signal=kill；restoreSession）
- [x] P2：session-scanner 四引擎（claude jsonl/opencode db/codex rollout/codebuddy；实测 42 会话）
- [x] P2：/terminal/status + /sessions + restore/delete API；移除 herdr/legacy（index.js 2850→1693 行）
- [x] P3：雷达 UI 重写（运行中 + 会话历史，子代理完成，bundle 71783B）
- [x] 安装目录已同步（client.js 71783B + 新模块）
- [ ] 真机验证（重启 DSH）：新建→终端窗口→简报注入；会话历史恢复/删除；辅助功能授权
- [ ] 发布 v0.3（node scripts/release.mjs patch）
