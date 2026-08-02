# Task 8 Report

## 基线

- 工作目录：`/Users/jodu/Documents/Sinapsis/.worktrees/prototype-zero-control-room`
- 当前未跟踪项：`.codex/`、`src/.DS_Store`。按任务约束不修改、不暂存。
- 已阅读任务简报、`2026-07-31-multi-agent-turns-and-dream-memory-design.md` 的频道界面反馈与 SSE 章节、`2026-07-31-multi-agent-conversation-turns.md` 的 Task 7/8、现有前端组件与样式。

## RED

- `npm test -- src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.test.tsx`
- 结果：FAIL（4 个测试文件，5 个测试失败，`ConversationTurnDetail` 组件缺失）。
- 失败点符合预期：`@all` 未出现在建议中、Escape 未关闭建议、时间线未渲染 Turn 活动、Shell 不能从活动打开 Turn 详情。

## 实现摘要

- 扩展前端 Workspace DTO：`activeTurnsByChannel`、`TurnActivityView` 和公开 `ConversationTurnDetailView`。
- `MessageComposer` 支持 `@all` 与频道 Agent 建议，保留 Enter 发送、Shift+Enter 换行，并支持方向键、Enter 选择、Escape 关闭。
- `ChannelTimeline` 在底部按 Turn 稳定展示筛选、判断、排队、准备回复和 Handoff 活动；Agent 正式消息出现后隐藏对应准备状态。
- 新增 `ConversationTurnDetail`，只渲染公开 DTO 字段：候选、理由、轮次、调用状态、Handoff 路径和受控失败分类。
- `WorkspaceShell` 复用右侧 Context 面板加载 Turn 详情；`useWorkspaceEvents` 订阅 conversation 事件并复用 200ms 节流刷新。

## 验证

- 聚焦测试：`npm test -- src/api/use-workspace-events.test.tsx src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.test.tsx`，PASS（5 files / 53 tests）。
- 全量测试：`npm test -- --run`，PASS（50 files / 410 tests）。
- Build：`npm run build`，PASS。
- Diff check：`git diff --check`，PASS。

## 说明

- 视觉浏览器 QA 按任务要求留给复审后统一执行；本次用交互测试覆盖键盘建议、Timeline 活动点击和右栏详情。
- 未修改、未暂存 `.codex/` 和 `src/.DS_Store`。

## 修复轮次 1 RED

- 待补失败测试覆盖 5 个 Important 与 3 个 Minor：
  - 历史 Agent 回复不得隐藏新 Turn 的 `preparing`。
  - Timeline 完成活动视图迁移后不再渲染旧 `typingAgents`。
  - Turn detail 在 SSE snapshot 刷新期间不清空旧详情，并控制重复请求和旧请求回写。
  - Participant 正常 reason 不进入失败详情。
  - 非终态 Turn 支持人工取消、二次确认、防重复、错误保留和成功刷新；终态不显示取消。
  - `@` 建议支持中文和带空格身份名、频道成员边界、重复身份、ArrowUp、Escape 后重开。
  - 活动排序按阶段语义优先，再按 `queuePosition`。
  - `useWorkspaceEvents` 遇到立即刷新事件时取消已有节流 timer，避免重复刷新。
- RED 命令：`npm test -- src/api/use-workspace-events.test.tsx src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.test.tsx`
- RED 结果：FAIL（5 files，10 failed / 52 passed）。失败点对应审查项：旧 typing、历史回复隐藏 preparing、阶段排序、正常 reason 进入失败详情、缺少取消入口、带空格身份过滤、节流+立即刷新重复、详情刷新闪烁/重复。

## 修复轮次 1 GREEN

- Important 1：删除按频道历史 Agent 回复隐藏 `preparing` 的启发式；活动完全由 `activeTurnsByChannel` / Turn 状态驱动。补同 Agent 历史回复 + 新 Turn `preparing` 回归测试。
- Important 2：`ChannelTimeline` 不再接收或渲染旧 `typingAgents` 路径，避免 judging / queued / handoff 被误报为准备回复。
- Important 3：Turn detail 只在 `channelId` / `selectedTurnId` 改变时清空；snapshot 刷新期间保留旧详情、后台成功后替换，并用请求序号防旧请求回写。
- Important 4：Participant 失败详情只展示 `failed` 或 `skipped` 且 reason 为受控失败分类；spoken 的正常 reason 保留在候选区。
- Important 5：非终态 Turn 增加取消入口、二次确认、提交中禁用和防重复；失败保留详情并显示可恢复错误，成功刷新 snapshot 与当前详情，终态隐藏取消。
- Minor 1：`@` 建议支持中文、带空格身份名、重复身份去重、ArrowUp、Escape 后继续输入重开；保留 Enter 发送与 Shift+Enter 换行语义。
- Minor 2：活动排序改为阶段语义优先，再按实际 `queuePosition`，并补 DOM 顺序断言。
- Minor 3：`useWorkspaceEvents` 遇到立即刷新事件时取消已挂起节流 timer，避免 conversation + `message.created` 组合重复刷新。
- 代码审查后修复：同一 Turn 详情后台请求增加 in-flight 去重，避免连续 snapshot 刷新重复请求；`/task` direct Agent 解析支持带空格 identity 的完整匹配。
- 审查修复 RED：`npm test -- src/domain/message-intent.test.ts src/ui/WorkspaceShell.test.tsx -t "space|keeps existing turn details"`，FAIL（2 files，2 failed / 41 passed / 7 skipped）。
- 审查修复 GREEN：`npm test -- src/domain/message-intent.test.ts src/ui/WorkspaceShell.test.tsx -t "space|keeps existing turn details"`，PASS（2 files / 43 passed / 7 skipped）。
- 聚焦测试：`npm test -- src/domain/message-intent.test.ts src/api/use-workspace-events.test.tsx src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.test.tsx`，PASS（6 files / 69 tests）。
- 全量测试：`npm test -- --run`，PASS（50 files / 420 tests）。
- Build：`npm run build`，PASS。
- Diff check：`git diff --check`，PASS。
- 仍未修改、未暂存 `.codex/` 和 `src/.DS_Store`。

## 修复轮次 2

- RED：新增两个 `WorkspaceShell` 竞态测试，分别覆盖“旧详情请求在途时收到终态事件”和“取消成功后详情重拉失败”。两项均按预期失败。
- Turn 详情加载改为 single-flight + dirty 合并；请求在途期间到达的新快照会在当前请求完成后自动补拉，终态事件不会丢失。
- 取消 API 成功后立即记录本地已确认取消状态。即使 Bootstrap 或详情刷新失败，界面也不会重新开放取消入口。
- 详情刷新失败时保留旧详情，显示可恢复错误和“重试 Turn 详情”命令；重试成功后原位更新并清除错误。
- 聚焦测试：6 files / 70 tests passed。
- 全量测试：50 files / 421 tests passed。
- `npm run build` 与 `git diff --check`：通过。
