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
