# Task 5 实施报告：HandoffPolicy 与普通消息确定性回合

## 状态

已完成 Task 5。实现基于 `31c2852f18451dfae952557f359dfead0f520fbe`，仅修改 brief 指定的六个代码/测试文件，并新增本报告。未修改、未暂存 `.codex/` 与 `src/.DS_Store`。

## 实现

### HandoffPolicy

- 新增纯 `HandoffPolicy.validate()`，结构化 `agentId` 是唯一路由依据，不从公开文本中的 `@Agent` 推断 Handoff。
- 拒绝非频道成员、自交接、已发言 Agent、既有重复边、同一回复内重复目标、直接或间接依赖回环、空问题、第四轮和第三个目标。
- 保持输入顺序，分别返回 `accepted` 与带稳定机器原因码的 `rejected`；Coordinator 将每项结果持久化为 Handoff 记录。
- 回环检测使用显式 worklist 和 visited 集合，不会因已有环或长路径卡死。

### ChannelTurnCoordinator

- 新增 `dispatch(message)`、`cancel(turnId)`、`getActiveStates(channelId)`，并提供兼容门面所需的频道/Agent 取消方法。
- 普通消息按以下顺序执行：
  1. 创建 `screening` Turn。
  2. 本地职责预筛最多三个当前频道可用成员，并先持久化候选。
  3. 并行执行 Participation Probe。
  4. 只保留 `speak`，按依赖拓扑，再按 `matcherScore desc -> confidence desc -> queueAvailable desc -> lastSpokenAt asc -> agentId asc` 排序。
  5. 最多选择两个首轮发言者；依赖环内边被忽略并持久化 `dependency_cycle_ignored`。
  6. 第一位公开回复先通过 `ChannelMessageService.postAgent` 落库。
  7. 后续发言者读取包含前序公开回复的最新上下文做 duplicate check；`silent` 只更新参与记录，不发布占位消息。
  8. 公开回复落库后才验证并持久化 Handoff worklist，按轮次串行执行，最多三轮。
  9. 局部 Probe、duplicate check 或回复失败都持久化可解释原因；没有有效回复时 Turn 仍按 brief 以 `completed` 结束。
- Participation timeout 联合使用 `'confidence' in result` shape guard。超时 Invocation 先持久化为 `failed/errorCode=timeout`，再请求取消对应 Agent Session，不遗留 `running` 记录。
- Invocation 使用每 Agent 稳定队列，并持久化 queued/running/settled/failed/cancelled 状态。
- 所有 Turn、Participant、Invocation、Handoff 状态均先通过仓储落库，再发布 `conversation.*` 事件。默认事件通过 `repositories.inTransaction(unitOfWork => unitOfWork.afterCommit(event))` 接入现有 SSE publisher。
- `TurnActivity` 暴露 `screening/judging/queued/preparing/handoff` 与 queue position。
- 保留单个直接提及的兼容优先级：跳过普通预筛与 Participation，使用 `human_direct` Invocation，并允许受策略约束的 Handoff。
- 未实现 A6 的多提及并行分支或 `@all` 分支。

### ConversationCoordinator 兼容门面

- 保留 `dispatch(channelId, message): Promise<void>`，校验旧 `channelId` 参数后调用 `ChannelTurnCoordinator.dispatch(message)`。
- `getTypingAgentIds` 从 `getActiveStates` 派生并去重。
- `cancelChannel` 与 `cancelAgentInChannel` 委托给新协调器。

## 文件

- 新增 `server/application/handoff-policy.ts`
- 新增 `server/application/handoff-policy.test.ts`
- 新增 `server/application/channel-turn-coordinator.ts`
- 新增 `server/application/channel-turn-coordinator.test.ts`
- 修改 `server/application/conversation-coordinator.ts`
- 修改 `server/application/conversation-coordinator.test.ts`
- 新增 `.superpowers/sdd/2026-07-31-multi-agent-conversation-turns/task-5-report.md`

## TDD：真实 RED / GREEN

### Cycle 1：HandoffPolicy

- RED：`npm test -- --run server/application/handoff-policy.test.ts`
- 结果：退出码 1；Vitest 无法解析不存在的 `./handoff-policy`。
- GREEN：同命令退出码 0，`1 file / 8 tests passed`。

### Cycle 2：普通回合与兼容门面

- RED：`npm test -- --run server/application/handoff-policy.test.ts server/application/channel-turn-coordinator.test.ts server/application/conversation-coordinator.test.ts`
- 结果：退出码 1；新协调器文件不存在；门面 3 项分别因仍读取旧仓储、未派生 active states、未委托取消而失败。
- 首次 GREEN：实现最小状态机后，19 项中 18 项通过；唯一失败确认是测试夹具未写 `messages.sender_id`，修正夹具后 `3 files / 19 tests passed`。

### Cycle 3：timeout 与默认事件路径

- RED：加强 timeout Invocation 终态与默认 `afterCommit` 事件断言后，`channel-turn-coordinator.test.ts` 2 项失败：超时 Invocation 实际仍为 `running`，默认路径没有 `conversation.*` 事件。
- GREEN：加入 timeout 终态持久化、Session 取消和仓储 afterCommit 发布后，聚焦 `3 files / 19 tests passed`，build 通过。

### Cycle 4：独立 review 回归项

- 独立 Codex diff review 报告 1 个 P1、2 个 P2：单直接提及回归、公开回复 recency 无 sender attribution、同一回复重复 Handoff 目标。
- RED：新增三个回归断言，真实结果为 `2 files / 3 failed / 16 passed`。
- GREEN：补单直接提及、持久化公开消息 recency 回退和批内 Handoff 边累积后，最终聚焦 `3 files / 22 tests passed`。

## 完整验证

- 聚焦测试：`npm test -- --run server/application/handoff-policy.test.ts server/application/channel-turn-coordinator.test.ts server/application/conversation-coordinator.test.ts`
  - 结果：3 个测试文件通过，22 项测试通过。
- 完整测试：`npm test -- --run`
  - 结果：49 个测试文件通过，350 项测试通过，0 失败，退出码 0。
- 完整 build：`npm run build`
  - 结果：`tsc --noEmit` 通过；Vite 转换 1801 modules 并成功生成产物，退出码 0。
- 静态 diff 检查：`git diff --check`
  - 结果：无空白或补丁格式错误。

## 自审

- 逐项核对 brief：候选上限、并行 Participation、shape guard、确定性拓扑与排序、最多两位、公开回复先落库、duplicate silent 无占位、双失败 completed、Handoff 三轮与 worklist、事件持久化顺序、兼容门面均有实现和测试。
- Handoff 批内重复目标会立即看到前一条已接受边，不会生成重复 Invocation/idempotency key。
- 依赖环只删除环内约束并写原因，其余候选仍按稳定比较器运行。
- `finally` 清理 active execution；取消先标记 execution，再取消排队项/Session，防止完成路径覆盖 `cancelled` Turn。
- 未发现对 `.codex/`、`src/.DS_Store` 或 brief 外代码文件的修改。

## 风险

- 现有 `ChannelMessageService.postAgent` 没有 `senderId` 参数，且该文件不在 Task 5 允许修改范围内。Coordinator 仍严格通过该服务写公开回复，并在 `getLastAgentSpokenAt` 返回空时，使用已持久化 bootstrap 公开消息的 `authorName` 做 recency 回退。该回退受每频道最近 50 条 bootstrap 窗口限制；长期精确 recency 最好在后续允许修改消息服务时补充 Agent sender attribution。
- 单直接提及为保持既有入口与 brief 的跨来源优先级而保留；多提及与 `@all` 仍未实现，留给 A6。
- Handoff 记录当前仓储接口只有 create、没有 update，因此已接受记录保持 `accepted`，目标回复结果由 Invocation、Participant 与 Turn 终态表达；若后续 UI 要显示独立 `completed` Handoff 状态，需要由后续任务扩展仓储 patch 接口。
