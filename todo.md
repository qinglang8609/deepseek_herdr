
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
