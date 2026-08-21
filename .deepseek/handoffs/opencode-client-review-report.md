# 插件客户端代码审查报告

## 总体评估
代码整体结构清晰，WebSocket 生命周期管理、xterm 集成和错误边界处理有良好的基础设计。但存在**全局状态泄漏**、**渲染期副作用**和**过度静默的错误处理**等严重问题。

---

## CRITICAL

### 1. 全局 listWs WebSocket 永不关闭（内存泄漏）
- **位置**：`app.js` 模块级别 `connectListWs()`（第54-94行）
- **问题**：`RadarPanel` 卸载时，`useEffect` 只取消了 `subscribeAgents`（第650-653行），但模块级别的 `listWs` WebSocket **永远不会被 `close()`**。`onclose` 中的 `setTimeout(open, 2000)` 会无限重连。如果插件被禁用或热重载，旧连接持续存在。
- **修复**：给 `connectListWs` 返回清理函数，或让 `subscribeAgents` 在最后一个订阅者离开时关闭 `listWs`：
  ```javascript
  let subscriberCount = 0;
  function subscribeAgents(fn) {
      subscriberCount++;
      agentListeners.add(fn);
      fn(agentSnapshot);
      return () => {
          agentListeners.delete(fn);
          subscriberCount--;
          if (subscriberCount === 0 && listWs !== null) {
              try { listWs.close(); } catch {}
              listWs = null;
          }
      };
  }
  ```

### 2. 渲染期副作用直接修改父组件 ref
- **位置**：`app.js` 第311行 `AgentTerminal`
- **问题**：`if (signalRef !== void 0) signalRef.current = sendSignal;` 在**每次渲染时**直接修改父组件传入的 ref。违反 React 规则（副作用应在 effect 中），在并发模式下可能导致不可预测行为。
- **修复**：
  ```javascript
  useEffect(() => {
      if (signalRef) signalRef.current = sendSignal;
  }, [signalRef, sendSignal]);
  ```

### 3. connectListWs 存在竞态条件
- **位置**：`app.js` 第71-94行
- **问题**：`if (listWs !== null && ...)` 检查和 `listWs = ws` 赋值之间不是原子操作。`open()` 内部的检查在 `setTimeout` 回调中执行，如果 `onclose` 刚设置 `listWs = null` 后另一个 `connectListWs` 调用到达，可能创建重复连接。
- **修复**：使用锁标志：
  ```javascript
  let connecting = false;
  function connectListWs() {
      if (connecting) return;
      if (listWs !== null && ...) return;
      connecting = true;
      // ... 创建 ws 后 connecting = false
  }
  ```

---

## HIGH

### 4. ResizeObserver 未节流导致 WebSocket 消息洪泛
- **位置**：`app.js` `AgentTerminal` 第283-290行、`MiniTerminal` 第523-530行
- **问题**：拖动窗口或面板大小时，`ResizeObserver` 高频触发，每次都会发送 `resize` WebSocket 消息。快速拖动可能发送数十条消息。
- **修复**：对 `sendResize` 节流：
  ```javascript
  let resizeThrottle = null;
  const sendResize = () => {
      if (resizeThrottle !== null) return;
      resizeThrottle = setTimeout(() => { resizeThrottle = null; /* ... */ }, 200);
  };
  ```

### 5. 列表 WebSocket 断线无 UI 反馈
- **位置**：`app.js` `connectListWs` 第83-86行
- **问题**：`listWs` 断开时只静默重连（2秒后），没有任何状态更新通知用户列表数据可能已过时。用户会看到过时的 agent 列表。
- **修复**：添加连接状态到全局 store，在 `RadarPanel` header 显示离线指示器。

### 6. useDetailsColumn 闭包可能使用陈旧值
- **位置**：`app.js` 第135-148行
- **问题**：`enforce` 通过 RAF/MutationObserver 异步执行，捕获了渲染时的 `collapsed` 闭包值。如果 `collapsed` 在 schedule 和 enforce 执行之间快速切换，可能应用错误的宽度。
- **修复**：使用 ref 保存最新的 `collapsed` 值：
  ```javascript
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // enforce 中读取 collapsedRef.current
  ```

### 7. 构建脚本缺乏输入验证和错误处理
- **位置**：`build-client.mjs` 第17-23行
- **问题**：`readFileSync` 没有 try-catch，如果任何文件缺失，构建崩溃且无友好错误。`xtermCssBody` 的注入方式（第45行）假设文件已经是合法 JS 字符串字面量，这是一个隐式契约。
- **修复**：添加文件存在性检查和 try-catch，明确校验 vendor 文件格式。

---

## MEDIUM

### 8. 过度静默的错误处理（遍布代码）
- **位置**：`app.js` 约 20+ 处 `catch {}`
- **问题**：所有错误被静默吞掉（如第81、147、220、233、288、337-338、356、468、495、510、527、538行等）。生产环境调试极其困难，无法诊断用户问题。
- **修复**：至少记录到 `console.error`：
  ```javascript
  } catch (err) {
      console.error("[dsh-agent-commander] ...", err);
  }
  ```

### 9. AgentTerminal 和 MiniTerminal 大量重复代码
- **位置**：`app.js` 第176-320行 和 第424-544行
- **问题**：ws 连接逻辑、指数退避重连、resize、pinToBottom、xterm theme 配置完全重复，约 120 行逻辑几乎相同。
- **修复**：提取为 `useAgentTerminal(agentId, { interactive, scrollback, fontSize })` 自定义 hook。

### 10. theme 对象重复定义
- **位置**：`app.js` 第191-213行 和 第438-460行
- **问题**：完全相同的 xterm theme 对象定义了两次。
- **修复**：提取为常量 `const XTERM_THEME = { ... };`

### 11. ResizeObserver 回调内一损俱损
- **位置**：`app.js` `AgentTerminal` 第284-288行
- **问题**：`try { fit.fit(); sendResize(); pinToBottom(); } catch {}` 中如果 `fit.fit()` 失败，`sendResize` 和 `pinToBottom` 不会执行。
- **修复**：分别包装：
  ```javascript
  try { fit.fit(); } catch {}
  try { sendResize(); } catch {}
  try { pinToBottom(); } catch {}
  ```

### 12. NewAgentDialog 资源加载失败无提示
- **位置**：`app.js` 第337-338行
- **问题**：`/binaries` 和 `/skills` 加载失败时静默忽略，用户看不到可用引擎和技能列表，下拉框会异常。
- **修复**：显示加载失败提示：
  ```javascript
  .catch(() => setError("加载可用引擎/技能失败，请刷新重试"))
  ```

### 13. NewAgentDialog 提交成功后未重置 busy 状态
- **位置**：`app.js` 第344-360行
- **问题**：成功路径没有 `setBusy(false)`。虽然通常 `onClose` 会关闭对话框，但如果 `onClose` 抛异常，`busy` 会永远为 `true`。
- **修复**：使用 `finally` 重置状态：
  ```javascript
  finally { setBusy(false); }
  ```

### 14. SafePanel 无法从错误恢复
- **位置**：`app.js` 第607-635行
- **问题**：一旦捕获错误，只能显示静态错误信息。用户无法重试或恢复，必须刷新整个页面。
- **修复**：添加重试按钮或监听 `children` prop 变化重置 `error` 状态。

### 15. onCloseAgent 失败无反馈
- **位置**：`app.js` 第656-661行
- **问题**：`apiDelete` 失败时静默忽略，用户以为 agent 已关闭，实际上可能仍在运行。
- **修复**：显示错误提示或至少 `console.error`。

### 16. head.js 中未使用的导入和变量
- **位置**：`head.js` 第9-10行
- **问题**：`react_jsx_runtime` 和 `__commonJSMin` 未被使用，增加 bundle 大小和认知负担。
- **修复**：移除未使用的代码。

---

## LOW

### 17. 未使用的 CSS 类
- **位置**：`panel.css` 第131-157行
- **问题**：`.dhac_agent`、`.dhac_agentActive`、`.dhac_agentTop` 在 JSX 中没有使用（代码使用 `.dhac_card` 结构），疑似遗留代码。
- **修复**：移除未使用的样式。

### 18. 缺少可访问性（ARIA）属性
- **位置**：`app.js` 多个组件
- **问题**：按钮大多缺少 `aria-label`（虽然部分有 `title`）；模态框缺少 `role="dialog"`、`aria-modal="true"`；checkbox 缺少关联的 label 结构。
- **修复**：补充 ARIA 属性以支持屏幕阅读器。

### 19. 缺少移动端/窄屏媒体查询
- **位置**：`panel.css`
- **问题**：没有针对小屏幕的适配，`.dhac_dialog` 在小屏幕上可能溢出。
- **修复**：添加 `@media (max-width: 480px)` 调整布局。

### 20. agent.exited 类型检查不严格
- **位置**：`app.js` 第579行
- **问题**：`agent.exited` 使用 truthy 检查，如果后端返回字符串 `"false"` 会误判为 true。
- **修复**：使用 `agent.exited === true`。

### 21. 代码风格不一致
- **位置**：`app.js`
- **问题**：混用 `void 0` 和隐式 `undefined` 检查；部分条件使用 `!== void 0`，部分使用 `!== null`。
- **修复**：统一风格（推荐全等比较 `=== null` / `=== undefined`）。

---

## 通过的项 ✓

| 检查项 | 说明 |
|---|---|
| WebSocket 重连机制 | 指数退避（500ms × 2^retry，上限 6 次）设计合理 |
| xterm 初始化和 dispose | `term.dispose()` 在 cleanup 中正确调用 |
| ResizeObserver 清理 | `disconnect()` 在 cleanup 中正确调用 |
| pinToBottom 防抖 | 60ms timeout + guard 防止多次触发 |
| SafePanel 错误边界 | `getDerivedStateFromError` + `componentDidCatch` 正确实现 |
| localStorage 持久化 | `PANEL_KEY` 状态读写有 try-catch 保护 |
| agentId effect 依赖 | `[agentId]` 作为依赖，变化时正确清理旧连接 |
| stopPropagation 使用 | 关闭按钮正确阻止事件冒泡到卡片点击 |
| URL 参数编码 | `encodeURIComponent` 正确使用 |
| CSS Design Tokens | 全面使用 `--dsw-alias-*` 变量，无硬编码颜色 |
| 构建脚本递归创建目录 | `mkdirSync(..., { recursive: true })` 正确 |
| MiniTerminal 配置 | `disableStdin: true` 和 `convertEol: true` 恰当 |

---

## 总结

**最紧急修复的是 CRITICAL 级别的 3 项：**
1. **全局 WebSocket 泄漏**是当前最严重的内存和连接泄漏问题，必须添加引用计数或生命周期管理来确保卸载时关闭。
2. **渲染期副作用修改 ref** 违反 React 基本原则，在严格模式或并发模式下会出问题。
3. **竞态条件**可能导致重复 WebSocket 连接，增加服务器负担。

**HIGH 级别的 4 项**影响性能和用户体验，应在下一次迭代中处理。

**MEDIUM 级别的 9 项**主要是代码质量、可维护性和错误诊断能力，适合在长期维护中逐步优化。

整体代码架构合理，组件职责分离清晰，通过提取自定义 hook 和加强错误日志，可以显著提升可维护性。
