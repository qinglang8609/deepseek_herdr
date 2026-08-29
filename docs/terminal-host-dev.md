# 终端宿主模式开发文档（v0.3 方向）

> 分支：`feat/terminal-host` ｜ 更新：2026-08-29
>
> 目标：**不再在浏览器渲染终端**，也不依赖 herdr —— 智能体跑在**系统终端窗口**
> （Terminal.app / Ghostty / iTerm2）里，雷达变成「运行中 + 会话历史」面板
> （cc-switch 式会话管理）。统一指挥功能（agent_* 工具 + .deepseek 共享记忆）保留。

---

## 1. 为什么（取代 herdr/legacy）

| 痛点 | 本方案的解法 |
|------|-------------|
| 浏览器终端卡死/乱码 | 不渲染终端，输出在系统终端窗口 |
| herdr 全屏 TUI 读取会滚动 agent 界面 | 不读实时输出，只做进程存活监控 |
| herdr daemon 生命周期/CLI/同步的复杂度 | 只需 `open -a <App>` + pidfile + kill |
| 会话难以跨重启恢复 | 四引擎会话历史 + 一键恢复（cc-switch 式） |

## 2. 架构

```
DSH 插件
├── lib/terminal-launcher.js   拉起系统终端窗口（LaunchServices open，免自动化权限）
│     Terminal: 写临时 .command 脚本 + open -a Terminal <script>
│     Ghostty:  open -a Ghostty --args -e bash -lc "<cmd>"
│     iTerm2:   写 .command + open -a iTerm <script>
│     PID: 命令模板 `cd <cwd> && echo $$ > <pidfile> && exec <engine> <args>`
│          （exec 替换 shell → pidfile 即引擎 PID）
├── lib/process-monitor.js      kill -0 存活探测 / pgrep 兜底 / 发信号
├── lib/terminal-registry.js   注册表：create(拉起终端)→2s 轮询存活→灰/绿；
│     send/approve 走 keystroke.js（系统按键，需辅助功能权限）；signal=kill
├── lib/session-scanner.js     四引擎会话历史扫描/删除（cc-switch 式）
├── lib/keystroke.js           System Events 按键注入（agent_send/approve）
└── src/client/                雷达 UI：运行中 + 会话历史（无终端渲染）
```

## 3. 引擎与会话数据源（已实测）

| 引擎 | 二进制 | 新建 | 恢复 | 会话存储 | 删除 |
|------|--------|------|------|---------|------|
| claude | ~/.local/bin/claude | `claude` | `claude --resume <id>` | ~/.claude/projects/<slug>/*.jsonl | 删文件 |
| opencode | ~/.opencode/bin/opencode | `opencode [--prompt <简报>]` | `opencode -s <id>` | opencode.db(SQLite) | opencode session delete / sqlite |
| codex | ~/.local/bin/codex | `codex` | `codex resume <id>` | ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl | codex delete <id> / 删文件 |
| codebuddy | 待确认 | `codebuddy` | `codebuddy --resume <id>` | ~/.codebuddy/projects/<slug>/*.jsonl(假定同 claude) | 删文件 |

slug = cwd 中所有非字母数字替换为 `-`（claude 实测：`deepseek_herdr` → `deepseek-herdr`）。

## 4. 关键机制验证记录

- `open -a Terminal <script.command>` + `echo $$ > pidfile && exec <cmd>` → pidfile 捕获引擎 PID ✅（真实测试 PID=48008）
- **注意**：osascript `do script` 需要 Apple Events 自动化权限（受限环境 -10004）→ 统一改用 LaunchServices `open`，免权限
- send/approve 的 System Events keystroke 需要「辅助功能」权限：系统设置 → 隐私与安全 → 辅助功能 → DeepSeek Harness
- 沙箱（DSH 文件沙箱）会阻止跨应用 launch 测试 → 真机验证需在 DSH 应用内进行

## 5. 状态语义（终端模式简化）

- 运行中（进程存活）→ 绿；终端被关/进程退出 → 灰（exited），2s 轮询检测
- 不再区分 working/idle/blocked（无终端输出可读）；简报注入状态 briefing: pending/done

## 6. API（相对 /agent-commander/api）

| 端点 | 说明 |
|------|------|
| GET /terminal/status | { app, label, apps:[{id,label,available}], engines:[{id,installed}] } |
| GET /sessions?cwd= | 会话历史（按时间倒序） |
| POST /sessions/restore {engine,id,cwd} | 恢复会话（新终端窗口） |
| DELETE /sessions/:engine/:id?cwd= | 删除会话 |
| GET/POST /agents… | 运行中智能体（同旧版） |
| WS /ws/list?cwd= | 运行中列表推送（2s 存活轮询） |

## 7. 实施阶段

- [x] P1：terminal-launcher + process-monitor + terminal-registry（拉起/监控/灰态）
- [x] P2：session-scanner 四引擎 + /sessions API + 移除 herdr/legacy 代码
- [ ] P3：雷达 UI（运行中 + 会话历史；子代理实现中）
- [ ] P4：构建验证 + 真机（DSH 内）验证 + 发布 v0.3

## 8. 已知限制（诚实说明）

1. 系统终端无 pty：agent_read 不返回实时输出（返回空 + 提示）；结果以会话历史为准
2. agent_send/approve 需辅助功能权限（无权限时报错提示，不静默失败）
3. 恢复命令按引擎实测参数；codebuddy 参数待真机确认（降级为「打开引擎可手动恢复」）
