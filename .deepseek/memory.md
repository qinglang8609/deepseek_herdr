# 记忆层操作手册 (SQLite)

> 团队共享记忆：所有智能体（claude / opencode / codex / DeepSeek）通过 sqlite3 CLI 读写同一个数据库。
> 工作经验沉淀见 `.deepseek/experience.md`。

---

## 文件结构

| 文件 | 用途 |
|------|------|
| `.deepseek/memory.db` | SQLite 知识库（机器可查询，本文档的主角） |
| `.deepseek/task-board.md` | 任务看板（人类可读视图，同步写 SQLite tasks 表） |
| `.deepseek/experience.md` | 经验总结（人类可读视图，同步写 SQLite memory 表） |
| `.deepseek/handoffs/` | 交接文件（长报告存放处，同步在 SQLite handoffs 表登记） |
| `.deepseek/memory.md` | 长期记忆模板（项目事实/决策/代理特长） |

SQLite 是结构化查询的权威来源，Markdown 文件是人类可读视图。两者应保持同步。

---

## 数据库表结构

数据库路径：**`.deepseek/memory.db`**（相对项目根目录）

### memory 表 — 知识条目

```sql
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL DEFAULT 'experience',  -- 命名空间（见下方约定）
  title TEXT NOT NULL,                           -- 简短标题
  body TEXT NOT NULL,                            -- 内容
  tags TEXT DEFAULT '',                          -- 逗号分隔标签
  source TEXT DEFAULT '',                        -- 写入者（智能体名/ID）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### tasks 表 — 任务跟踪

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                           -- 任务标题
  owner TEXT DEFAULT '',                         -- 负责智能体
  status TEXT DEFAULT '🔄',                      -- 状态（见状态机）
  started_at TEXT DEFAULT (datetime('now')),
  result TEXT DEFAULT ''                         -- 结果摘要
);
```

### handoffs 表 — 跨智能体交接

```sql
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,                      -- 交接发起者
  to_agent TEXT DEFAULT '',                      -- 接收者（空=任意人可接）
  subject TEXT NOT NULL,                         -- 交接主题
  body TEXT NOT NULL,                            -- 交接内容
  status TEXT DEFAULT 'open',                    -- open | picked | done
  created_at TEXT DEFAULT (datetime('now'))
);
```

### code_links 表 — 代码关联

```sql
CREATE TABLE code_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,                            -- 文件路径
  symbol TEXT NOT NULL,                          -- 符号名
  kind TEXT DEFAULT '',                          -- function | class | route | dep
  target TEXT DEFAULT '',                        -- 关联文件/符号
  note TEXT DEFAULT ''                           -- 备注
);
```

---

## 命名空间约定

memory 表的 `namespace` 字段取值：

| namespace | 中文 | 用途 | 示例 |
|-----------|------|------|------|
| `facts` | 项目事实 | 稳定的项目信息，很少变更 | "数据库用 PostgreSQL 16" |
| `decisions` | 决策记录 | 技术选型/架构决策 + 理由 | "选 Redis 做缓存，因为…" |
| `experience` | 经验教训 | 可复用的经验和最佳实践 | "审查发现：静默 catch 吞错…" |
| `pitfalls` | 踩坑记录 | 踩过的坑和规避方案 | "node-pty spawn 需要 chmod 755" |
| `patterns` | 复用模式 | 可重复使用的模式/模板 | "多智能体并行审查模式" |

---

## 任务状态机

tasks 表 `status` 字段取值：

| 状态 | 含义 |
|------|------|
| 🔄 | 进行中（默认） |
| ✅ | 已完成 |
| ❌ | 失败 |
| ⏸️ | 暂停 |

状态流转规则：

```
🔄 → ✅（成功完成）
🔄 → ❌（失败）
🔄 → ⏸️（暂停）
⏸️ → 🔄（恢复）
❌ → 🔄（重试）
```

---

## 读取操作（开始工作前必读）

查看最近记忆条目：

```bash
sqlite3 .deepseek/memory.db "SELECT id, namespace, title, substr(body,1,200) FROM memory ORDER BY id DESC LIMIT 20;"
```

查看进行中的任务：

```bash
sqlite3 .deepseek/memory.db "SELECT * FROM tasks WHERE status = '🔄' ORDER BY id;"
```

查看未完成的交接：

```bash
sqlite3 .deepseek/memory.db "SELECT * FROM handoffs WHERE status = 'open' ORDER BY id;"
```

按文件查找代码关联：

```bash
sqlite3 .deepseek/memory.db "SELECT * FROM code_links WHERE file LIKE '%路径关键词%';"
```

---

## 写入操作（完成工作后必写）

记录新决策：

```bash
sqlite3 .deepseek/memory.db "INSERT INTO memory (namespace, title, body, tags, source) VALUES ('decisions','用 WAL 模式','SQLite 开启 WAL 提升并发读写性能','sqlite,性能','claude');"
```

创建新任务：

```bash
sqlite3 .deepseek/memory.db "INSERT INTO tasks (title, owner, status) VALUES ('修复路径穿越','claude','🔄');"
```

更新任务状态：

```bash
sqlite3 .deepseek/memory.db "UPDATE tasks SET status='✅', result='已修复并添加测试' WHERE id=1;"
```

创建交接记录：

```bash
sqlite3 .deepseek/memory.db "INSERT INTO handoffs (from_agent, to_agent, subject, body) VALUES ('claude','opencode','审查报告','详见 .deepseek/handoffs/claude-review.md');"
```

记录代码关联：

```bash
sqlite3 .deepseek/memory.db "INSERT INTO code_links (file, symbol, kind, target, note) VALUES ('plugin/lib/index.js','seedSharedMemory','function','MEMORY_FILES','记忆层播种函数');"
```

记录经验教训：

```bash
sqlite3 .deepseek/memory.db "INSERT INTO memory (namespace, title, body, tags, source) VALUES ('experience','审查经验','并行审查比串行快 60%+，分工：claude 负责深度，opencode 负责广度','审查,多智能体','claude');"
```

---

## 规则

1. **串行写、并行读** — SQLite 单进程写入限制：读操作可并行，写操作必须串行执行（避免 SQLITE_BUSY 锁冲突）。写入频繁时可启用 WAL 模式：`sqlite3 .deepseek/memory.db "PRAGMA journal_mode=WAL;"`
2. **绝不 DROP/ALTER 表** — 只允许 INSERT / UPDATE / SELECT / DELETE
3. **条目简明扼要** — 详细报告存 `.deepseek/handoffs/`，数据库只存摘要
4. **路径统一** — 数据库路径始终为 `.deepseek/memory.db`（相对项目根目录）
5. **Markdown 与 SQLite 同步** — 更新任务看板时同步更新 tasks 表，记录经验时同步写 memory 表
6. **完成任务后必做** — 更新 tasks 状态 → 写 memory 经验 → 有交付物则创建 handoffs
