# Task 6 报告：Dream 入口与审核中心

## 交付内容

- 左侧导航新增固定 Dream 入口，使用 Bootstrap 的 `pendingMemoryCandidateCount` 显示待确认数量。
- Dream Center 作为主内容独立视图，提供待确认、已接受、已忽略、已替代四个审核页签；候选列表显示 scope、摘要、来源频道、来源数量与提取时间。
- 候选详情支持编辑内容与 scope、接受、忽略，并在提交期间锁定两个审核动作。接受成功后切换到“已接受”页签；来源跳转先回到来源频道再定位公开消息。
- “立即 Dream”支持全部活跃频道或单一频道，并明确反馈运行中、无候选完成和失败状态。
- 移动端将候选列表和详情分为上下两个受限滚动区域，避免相互覆盖。

## 后端与安全

- `GET /api/memory-candidates?status=` 严格只接受 `pending`、`accepted`、`ignored`、`superseded`。
- Candidate 响应加入来源频道 ID/名称、来源消息 ID 与来源数量；查询只读取公开消息关联，未返回 Runtime prompt、日志、artifact 或消息正文。
- Bootstrap 返回 `pendingMemoryCandidateCount`，Dream/Memory SSE 事件会触发工作空间刷新。

## TDD 与验证

- 首先新增并运行 RED：缺失 Dream UI、导航入口，以及未过滤的 Candidate API 均如预期失败。
- 后续补充“接受后进入已接受页签”的 RED，再实现 GREEN。
- 聚焦前端：5 个文件，60 项通过。
- 受影响后端：4 个文件，103 项通过。
- 全量：59 个文件，586 项通过。
- `npm run build` 通过；`git diff --check` 通过。

## 注意事项

- 任务开始前已有 `.superpowers/sdd/2026-07-31-dream-memory/progress.md`、`.codex/` 与 `src/.DS_Store` 工作区改动；均未纳入本任务暂存或提交。

## Fix Round 1

- Dream POST 的 `queued` 结果现在持续锁定运行按钮，按目标 run 轮询 `GET /api/dream/runs` 至全部终态；成功分别反馈无候选或候选数量，失败/取消、查询失败和超时均解除运行状态并给出中文反馈。轮询会在卸载或刷新代次变化时清理，避免并发残留。
- WorkspaceShell 每次 Bootstrap/SSE 刷新都会递增 `refreshGeneration`，Dream Center 只按当前页签重新读取候选并以请求序号丢弃过期响应；`candidate_created`、`candidate_reviewed` 的刷新因此会自动更新审核列表。
- 390px 窄屏 Dream 视图保留导航切换按钮；审核页签实现 roving `tabIndex`、左右箭头、`aria-controls` 与 `tabpanel`。
- 已审核候选以 `reviewedContent`、`reviewedScope`、`reviewedChannelId` 展示并全部只读；候选详情提供每一条来源的跳转入口。
- 新增 `GET /api/channels/:channelId/messages/:messageId`，严格校验频道、未删除状态和 Thread 根关系，只返回公开消息与同频道公开 Thread 根。前端临时合并这些消息，支持 Bootstrap 50 条窗口以外的旧 root/reply；root 在 Timeline 定位，reply 自动打开并聚焦 Thread。
- 来源元数据增加 `threadRootMessageId`，继续只投影公开频道/消息标识，不暴露 Runtime prompt、日志或 artifact。

## Fix Round 1 验证

- RED：队列轮询、失败终态、移动导航、只读审核值、旧来源 root/reply、多来源跳转、候选读取竞态、ARIA 键盘页签及安全来源端点均先以失败测试确认缺口。
- 聚焦与受影响测试：5 个文件，157 项通过（现有 SSE 测试仍有既存 React `act(...)` 警告，不影响结果）。
- 类型检查：`npx tsc --noEmit` 通过。
- 全量：`npm test -- --run`，59 个文件、595 项通过。
- `npm run build` 通过；`git diff --check` 通过。

## Fix Round 2（限定 P1）

- DreamRun 公共 API 不返回内部 raw `error`；失败/取消仅投影确定性 `errorCategory`：`runtime_failure`、`service_restarted`、`cancelled`。
- Dream Center 改为按安全类别输出中文提示，不再显示“未知错误”或任意运行时/网络/启动错误正文。
- terminal failed、轮询超时、轮询请求失败、启动失败统一清除绿色“Dream 正在运行...”状态，只保留一个 alert，并重新启用运行按钮和范围选择。
- 新增真实异步失败路径与 API 投影脱敏 RED 测试后实现 GREEN。

## Fix Round 2 验证

- 聚焦：`src/ui/DreamCenter.test.tsx` 与 `server/app.test.ts`，53 项通过。
- 类型检查：`npx tsc --noEmit` 通过；全量 `npm test -- --run` 59 个文件、599 项通过；`npm run build` 与 `git diff --check` 通过。
