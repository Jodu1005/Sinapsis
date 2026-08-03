# Dream Memory Task 5 报告

## 完成状态

已完成 Task 5：人工审核服务、Memory 管理 API、Dream 手动运行 API 与 Dream/Memory SSE 生命周期事件。

## TDD 记录

1. 先新增 `memory-review-service.test.ts`、API 契约测试和 SSE 事件测试。
2. 首次执行：

   ```bash
   npm test -- server/application/memory-review-service.test.ts server/app.test.ts server/adapters/sse/sse-domain-event-publisher.test.ts
   ```

   预期失败，实际因审核服务与事件集合、路由尚不存在而失败。
3. 实现后执行聚焦测试、SQLite 仓储回归、全量测试与构建，均通过。

## 实现说明

- `MemoryReviewService` 只允许 `pending` Candidate 接受或忽略；`ignored`、`superseded` 和其他非待审状态均拒绝。
- 重复接受 `accepted` Candidate 会按 `memory_sources.candidate_id` 返回第一次关联的 Memory，不会重新写入或改变目标。
- 人工接受 Channel scope 时，`channelId` 是最终目标频道：服务验证它存在，Memory 保存此频道；Candidate 继续保留其 Dream 来源频道，并新增 `reviewedChannelId` 记录人工最终选择。
- Global scope 强制最终 `channelId` 为 `null`。
- 审核和 PATCH 内容要求非空、原始输入不超过 10,000 字符，并复用 Memory consolidation 的敏感内容检测。
- PATCH 保留 `sourceCandidateId` 并重新计算 hash；相同 scope/频道的活动 Memory 内容冲突转为 `DomainError`，HTTP 返回 409。
- DELETE 仅归档 Memory，设置 `archivedAt`；`memory_sources` 来源行保持不变。
- 所有新增请求体使用 `assertOnlyKeys` 限定字段；Dream Run API 响应显式投影，省略 `error` 等可能承载运行时细节的字段。SSE 仍只序列化 `DomainEvent` 的 ID、类型、实体和时间，不包含 Memory 内容、prompt、runtime log 或 artifact。
- 新增 SQLite migration 23，为 `memory_candidates.reviewed_channel_id` 和 scope 一致性触发器提供持久化约束。
- Dream run 创建/更新、Candidate 创建/审核及 Memory 变化均在事务提交后发布对应事件。

## 验证

```bash
npm test -- server/application/memory-review-service.test.ts server/app.test.ts server/adapters/sse/sse-domain-event-publisher.test.ts server/adapters/sqlite/sqlite-repositories.test.ts
# 4 files, 97 tests passed

npm test -- --run
# 57 files, 575 tests passed

npm run build
# tsc --noEmit 与 vite build passed

git diff --check
# passed
```

## 变更文件

- `server/application/memory-review-service.ts`
- `server/application/memory-review-service.test.ts`
- `server/application/memory-consolidation-protocol.ts`
- `server/app.ts`
- `server/app.test.ts`
- `server/domain/events.ts`
- `server/domain/memory.ts`
- `server/ports/repositories.ts`
- `server/adapters/sqlite/schema.ts`
- `server/adapters/sqlite/sqlite-repositories.ts`
- `server/adapters/sqlite/sqlite-repositories.test.ts`
- `server/adapters/sse/sse-domain-event-publisher.test.ts`

## Concerns

无已知阻塞项。保留了既有直接仓储调用在未传 `reviewedChannelId` 时使用 Dream 来源频道的兼容行为；HTTP 接口始终传入人工明确选择的最终频道。

## Fix Round 1

独立审查提出的五项边界问题已按 TDD 修复：

1. accept 与 PATCH 路由改为把原始 `content` 字符串交给审核服务；服务在 normalize 前检查原始长度，尾随空白不能绕过 10,000 字符上限。
2. Dream 手动运行先验证频道并抛出 `NotFoundError`；审核服务通过仓储 `getMemory` 将缺失 Memory 的 PATCH/DELETE 转为同一 404 边界。
3. migration 23 在安装触发器前回填 v22 中已接受、Channel scope Candidate 的最终频道，使用 `COALESCE(memory_candidates.channel_id, dream_runs.scope_id)`；真实 v22 升级测试验证回填、外键检查与触发器。
4. SSE publisher 在 `client.write` 前显式投影 `id`、`type`、`occurredAt`、`entityType`、`entityId`，恶意扩展的 prompt/content/log/artifact 会被剥离。
5. DELETE Memory 把缺省 body 当作空对象，并对存在的 JSON body 执行 `assertOnlyKeys([], body)`；非法字段稳定返回 400。

Fix Round 1 验证：聚焦 100 项、SQLite 54 项、全量 578 项测试均通过；`npm run build` 与 `git diff --check` 通过。
