# 任务看板

| 任务 | 负责人 | 状态(🔄/✅/❌) | 开始时间 | 结果 |
|------|--------|--------------|---------|------|
| 审查 plugin/package.json | ceshi(claude) | ✅ | 08-21 12:40 | 1 CRITICAL + 1 HIGH + 3 MEDIUM + 1 LOW；详见汇报 |
| 审查插件 client 端（并行） | opencode | ✅ | 08-21 12:47 | 3 CRITICAL + 4 HIGH + 9 MEDIUM + 5 LOW；报告存 handoffs |
| 审查 plugin/node 端（并行） | claude | ✅ | 08-21 12:47 | 3 CRITICAL + 4 HIGH + 6 MEDIUM + 4 LOW；报告已汇总 |
| 弹窗完善（技能默认全选+会话信息） | opencode | ✅ | 08-21 13:05 | 已落地并验证 |
| 记忆层端到端测试+MEMORY.md 完善 | claude | ✅ | 08-21 13:05 | sqlite3 可用、CRUD 全通、手册重写 |
| 持久化/恢复（pid+会话信息+重启恢复） | DeepSeek(总指挥) | ✅ | 08-21 13:10 | 闭环测试通过 |
| 五项迭代（去折叠/新类型/退出命令/workspace 捕获/卡片信息） | DeepSeek(总指挥) | ✅ | 08-21 14:10 | 已部署；codebuddy/pi/qwen 本机未装，装后自动可检测 |
| 新会话侧边栏修复+主界面弹出按钮；每智能体独立压缩(/compact) | DeepSeek(总指挥) | ✅ | 08-21 15:05 | 修复全局列宽 enforce 的 MutationObserver 一次性 bug（raf 未复位）；悬浮「🤖 雷达」按钮自动贴侧边栏左缘、桌面端避开标题栏拖拽区；compact 端点/工具/UI 已就绪（node 端需重启应用生效） |
| 去掉总压缩按钮（一键压缩缓存） | DeepSeek(总指挥) | ✅ | 08-21 15:20 | 彻底移除 🧹 全局按钮 + CacheDialog + window.dshAgentCommander.cache（服务器 /cache/compress 保留但 UI 不再调用）；压缩/清空均按智能体独立：卡片与详情栏 🗜=压缩当前会话(/compact)、↺=清空会话历史(/clear 或 /new)；已验证运行实例(50462)返回的 bundle 无任何全局压缩残留 |
| 全项目代码审查（plugin 端 + 最近改动） | opencode(测试专家) | 🔄 | 08-22 12:5x | 进行中 |
| 修复 CRITICAL #3-6 + HIGH #7-11（v0.2.0 审查遗留） | claude | ✅ | 08-23 | 8 项修复 + bundle 重建；详见汇报 |
| 修复智能体状态卡死（opencode idle→working 不回落） | claude | ✅ | 08-23 | 周期巡检 statusSweep 每 5s，静默 25s 且无活跃特征→降级 idle；构造函数启动定时器，shutdown/disposeAll 清理 |
| 已部署插件版本号同步为0.2.1 | claude | ✅ | 08-23 | 已更新 ~/.dsh/profiles/web/.../package.json version=0.2.1，验证通过 |
