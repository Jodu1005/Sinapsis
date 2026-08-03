# 全局频道与 Thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将频道从代码仓中解耦为全局唯一实体，并提供可用于 Agent 与任务协作的 Thread。

**Architecture:** SQLite 迁移先建立全局频道、Thread 消息和频道订阅的持久化语义；应用服务将频道上下文与任务执行上下文拆分；UI 将频道作为唯一主导航，在右侧按需展示 Thread 与任务。

**Tech Stack:** TypeScript、Node SQLite、Express、React、Vitest、Testing Library。

## Global Constraints

- 频道名称以 trim 后小写形式全局唯一；归档频道保留历史但不可写入。
- 任务始终绑定一个工作空间与该工作空间中的代码仓。
- Thread 回复不显示在频道时间线；Agent 同样遵循 Thread 根。
- 新增行为必须先以 Vitest 测试验证失败，再实现。

---

### Task 1: 全局频道持久化迁移

**Files:** `server/adapters/sqlite/schema.ts`、`server/adapters/sqlite/sqlite-repositories.ts`、`server/domain/workspace.ts`、SQLite 测试。

- [x] 写入重复频道归档与全局唯一约束的失败测试。
- [x] 将 channels 迁移为产品语义上的全局实体，保留技术归属并创建活跃名称唯一约束、`archived_at`。
- [x] 运行 SQLite 测试。

### Task 2: Thread 消息与频道订阅领域服务

**Files:** `server/domain/message.ts`、`server/ports/repositories.ts`、消息服务、ConversationCoordinator、应用路由及测试。

- [x] 写入回复必须指向同频道根消息、回复不会进入主时间线的失败测试。
- [x] 增加 `threadRootMessageId`、消息查询、自动订阅 Agent 和 Thread 会话键。
- [x] 运行应用与协调器测试。

### Task 3: 任务绑定工作空间与 Thread

**Files:** task domain/service/coordinator、API、测试。

- [x] 写入任务必须校验 workspace/repository/channel/Thread 根关系的失败测试。
- [x] 创建任务根消息，并使生命周期消息写入相同 Thread。
- [x] 运行任务与集成测试。

### Task 4: 全局频道和 Thread UI

**Files:** workspace view/API client、WorkspaceShell、RepositorySidebar、ChannelTimeline、MessageComposer、新 Thread 面板及测试。

- [x] 写入频道不随工作空间改变、打开 Thread、Thread 回复的失败 UI 测试。
- [x] 渲染全局频道、当前任务工作空间和 Thread 面板。
- [x] 完整测试、构建与本机浏览器验收。
