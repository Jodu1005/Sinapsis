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

---

# Task 5 修复轮 1/5

## 状态

已完成本轮 7 项 Critical/Important 修复。修复基于 Task 5 提交 `57ca2742cf5995ecf3c1fb000729c61c7d4048f4`，未修改或暂存 `.codex/`、`src/.DS_Store`，未实现 A6 多提及或 `@all`。

## 逐项实现

1. **Invocation 级取消**
   - `AgentInvocationQueue.cancelInvocation(id)` 精确返回 `queued/running/not_found`；queued 项立即移除并以 `AgentInvocationQueueCancelledError` 拒绝，之后不会执行。
   - `ConversationSessionService.cancelInvocation(id)` 只定位 `active.input.conversation.invocationId` 的 Session generation，并以带 `invocationId` 的 `ConversationInvocationCancelledError` 结束该 Invocation。
   - Turn、Agent、Participation timeout 全部按 Invocation ownership 取消，不再用频道/Agent 粒度取消普通 Turn 工作。
2. **非成员 Handoff 持久化与 migration 16**
   - `ConversationHandoff` 新增 `requestedTargetAgentId`；`toAgentId` 改为可空，只保存验证通过且存在的 Agent FK。
   - migration 16 重建 `conversation_handoffs`，回填旧数据的 raw target，新增 `updated_at` 和 `failed` 状态；同时重建 `turn_participants` 以支持 `cancelled`。
   - 真实 version 15 文件重开升级回归验证旧 Participant/Handoff 数据不丢失。
   - 本任务占用 migration 16；尚未实现的 Dream migration 必须顺延为 migration 17 或更高。
3. **协议/Policy 分层**
   - `parsePublicResponse` 只执行结构校验与 20 个目标的绝对安全上限，允许空 `question`。
   - `HandoffPolicy` 保持业务上限 2，并负责 `max_targets_exceeded`、`question_required`；公开 reply 先落库，拒绝项随后逐条持久化。
4. **Agent sender attribution**
   - `ChannelMessageService.postAgent` 必须接收 `agentId` 并写 `messages.sender_id`；Conversation 与 Task 的全部 Agent 公开消息均传真实 ID。
   - 排序优先使用 `getLastAgentSpokenAt(channelId, agentId)`；按 `authorName` 的 50 条回退只读取 `senderId IS NULL` 的历史消息，避免改名和重名误归属。
5. **Handoff 终态**
   - 仓储新增 `updateConversationHandoff`；work item 携带 `handoffId`。
   - 目标公开回复成功落库后，先更新 Handoff 为 `completed`，再发布 `conversation.handoff_completed`；失败/目标缺失/Turn 终止更新为 `failed` 后发布 `conversation.handoff_failed`。
   - Turn completed/cancelled/failed 前清算所有遗留 `accepted`，不会留下半终态。
6. **取消状态一致性**
   - Session 取消成功后才清 activity；失败恢复 `execution.cancelled=false`，保留 active Session 与活动状态供重试，不发布 apology 或 Turn 终态。
   - Invocation 与非终态 Participant 均持久化为 `cancelled` 后，才发布 Turn completed 事件。
7. **兼容门面时序**
   - `ChannelTurnCoordinator.start(message)` 同步持久化初始 Turn，返回 `{ turn, completion }`；原 `dispatch` 仍可等待完整终态。
   - `ConversationCoordinator.dispatch` 只调用 start，因此 HTTP POST 不等待 Probe、多轮回复或 Handoff。
   - 后台流程统一将意外错误持久化为 failed Turn；completion 带内部 rejection observer，避免 unhandled rejection。

## 排序裁定

- 全局 Queue priority 保持 `human_direct > human_ordinary > participation > duplicate_check > automatic_handoff`；新的人类普通消息仍先于未开始的自动 Handoff。
- 同一 Turn 来源比较单独固定并测试为 `direct > handoff > responsibility(ordinary)`，没有借此实现 A6 分支。

## 修改文件

- `server/application/agent-invocation-queue.ts` / `.test.ts`
- `server/application/conversation-session-service.ts` / `.test.ts`
- `server/application/agent-conversation-protocol.ts` / `.test.ts`
- `server/application/channel-message-service.ts`
- `server/application/channel-turn-coordinator.ts` / `.test.ts`
- `server/application/conversation-coordinator.ts` / `.test.ts`
- `server/application/context-assembler.test.ts`
- `server/application/task-execution-coordinator.ts`
- `server/adapters/sqlite/schema.ts`
- `server/adapters/sqlite/sqlite-repositories.ts` / `.test.ts`
- `server/domain/conversation.ts`
- `server/ports/repositories.ts`
- `server/app.test.ts`
- `.superpowers/sdd/2026-07-31-multi-agent-conversation-turns/task-5-report.md`

## TDD：真实 RED / GREEN

### Cycle 1：Queue 与 Session 精确取消

- RED：聚焦 Queue/Session 测试退出码 1，新增 2 项分别因 `queue.cancelInvocation`、`service.cancelInvocation` 不存在而失败；17 项旧测试通过。
- 首次实现后 19 项断言通过，但 Vitest 捕获测试观察代码派生的 unhandled rejection，退出码仍为 1。
- GREEN：修正 Promise 观察方式后，`2 files / 19 tests passed`，无 unhandled error。

### Cycle 2：Handoff schema 与仓储终态

- RED：SQLite 聚焦测试 `1 failed / 24 passed`，未知目标命中 `NOT NULL constraint failed: conversation_handoffs.to_agent_id`。
- GREEN：migration 16 与仓储 patch 实现后 `25 tests passed`；补真实 migration 15 重开升级后 `26 tests passed`。

### Cycle 3：协议到 Policy

- RED：协议/Policy/Coordinator 聚焦测试 `2 failed / 27 passed`；解析器报 `handoffTo must contain at most 2 targets`，端到端公开回复未发布。
- GREEN：绝对上限 20、空问题下沉 Policy 后 `3 files / 29 tests passed`。

### Cycle 4：sender attribution 与精确 recency

- RED：Coordinator `1 failed / 12 passed`，两条公开回复 `senderId` 均为 null。
- 中间 RED：补 senderId 后 39 项中仅改名/重名排序失败，定位到名字回退仍读取已归属的新消息。
- GREEN：名字回退限定 `senderId IS NULL` 后，Coordinator/Context/Task `3 files / 39 tests passed`；超过 50 条窗口回归通过。

### Cycle 5：Handoff 终态

- RED：Coordinator `2 failed / 12 passed`，成功与失败目标都遗留 `accepted`。
- GREEN：work item 携带 handoffId 并补 terminal update 后 `14 tests passed`。

### Cycle 6：Turn 取消一致性

- RED：Coordinator `2 failed / 14 passed`；queued Turn 调用了粗粒度 Agent cancel，running 取消失败被 `allSettled` 吞掉并错误完成 Turn。
- 中间 RED：精确取消后仅 queued Participant 仍被通用错误路径标成 failed。
- GREEN：Queue typed cancellation 纳入取消分支后 `16 tests passed`；双 Turn、晚到不执行、失败保留 activity、重试与无 apology 均通过。

### Cycle 7：start/completion 与 HTTP 时序

- RED：门面 2 项因未调用 start 失败；HTTP 测试首次还暴露夹具缺少 Repository 前置条件。
- GREEN：引入 start/completion、修正 HTTP 夹具后，Facade/App/Coordinator `3 files / 46 tests passed`。

### 补充审查回归

- Queue 的 human ordinary 优先于 automatic handoff、同 Turn 来源排序、后台 Policy 异常持久化为 failed 首次合并执行即 GREEN：`2 files / 23 tests passed`。
- 首次 build 因测试字符串数组推断为 `string[]` 失败；显式标注 `TurnParticipant['source'][]` 后 build 通过。

## 完整验证

- 最终覆盖文件聚焦测试：10 个测试文件、138 项测试通过，0 失败，退出码 0。
- Queue/Session 聚焦：`2 files / 19 tests passed`。
- Protocol/Policy/Coordinator 聚焦：`3 files / 29 tests passed`。
- Facade/App/Coordinator 聚焦：`3 files / 46 tests passed`。
- SQLite migration/repository 聚焦：`1 file / 26 tests passed`。
- 完整测试：`49 files / 364 tests passed`，0 失败，退出码 0。
- Build：`tsc --noEmit` 与 Vite build 通过，1801 modules transformed，退出码 0。
- `git diff --check`：通过。

## 自审

- 所有普通 Turn 取消路径按 Invocation ID 处理；SessionService 原粗粒度 API 仅保留给既有显式管理能力，不再用于 Participation timeout 或 Turn/Agent 普通回合取消。
- queued 删除、running Runtime ownership、取消失败重试、Invocation/Participant/Turn 终态和事件发布顺序均有回归。
- Handoff 只从已落库公开回复进入 Policy；accepted 只在对应公开目标回复落库后 completed。
- 非成员 raw target 不进入 Agent FK；migration 15 到 16 在开启当前 schema 后通过真实文件重开测试。
- `getLastAgentSpokenAt` 是新消息精确来源；历史回退不能覆盖已有 sender attribution。
- 没有修改全局 Queue priority，没有实现多提及或 `@all`。

## 风险

- migration 16 重建两张 conversation 表；已覆盖现有 migration 15 数据升级，但部署前仍应按常规流程备份本地 SQLite 文件。后续 Dream schema 必须从 17 起编号。
- `senderId IS NULL` 的历史消息仍只能使用 bootstrap 最近 50 条名字回退；这是旧数据兼容限制，新写入消息不受影响。
- 若 failed Turn 本身的最终持久化也失败，completion 会拒绝但内部 observer 会阻止 unhandled rejection；当前项目没有独立后台错误日志端口，数据库/事件层故障仍需依赖进程日志与运维监控。
- `ConversationHandoff.status` 新增 `failed`、`toAgentId` 改为可空；未来新增消费者需覆盖该联合类型。

---

# Task 5 修复轮 2/5

## 状态

已修复取消 queued/running Participation 与 duplicate-check 后，异步 catch 覆写 Participant cancelled 终态的问题。修复基于 `775f10b05bda485d49c341339e8b9deb8df8fe3e`，未修改 `.codex/` 或 `src/.DS_Store`。

## 根因

- `probeCandidate` 捕获 Queue/Session 的 typed cancellation 后，无条件调用 `updateParticipant(... status: 'failed')`。
- `duplicateCheck` 将所有异常折叠为 `null`，调用方把 cancelled 当作普通 duplicate-check 失败并写成 `skipped/duplicate_check_failed`。
- `cancelParticipants` 虽先持久化 `cancelled`，上述 Promise continuation 仍可能随后执行，造成 Turn/Invocation 为 cancelled、Participant 为 failed/skipped。

## 实现

- 新增统一 `isInvocationCancellation` type guard，同时识别：
  - `AgentInvocationQueueCancelledError`
  - `ConversationInvocationCancelledError`
- Participation 在 await 返回与 catch 两处检查 execution cancellation；取消时读取并返回当前已持久化 Participant，不再写 failed。
- duplicate-check 使用独立 cancellation sentinel，不再将 typed cancellation 折叠成普通 `null`；调用方在 Turn 取消时立即返回当前 Turn，在单 Agent 取消时保留 cancelled Participant 并继续处理其他 Agent。
- response/handoff catch 与 `runInvocation` 状态判断改用同一个 typed guard。
- Coordinator 的 Participant 更新入口保护 `cancelled/failed`：异步分支不能将其改成其他状态。
- Handoff 公开回复返回后、写 completed 前再次检查 execution cancellation，避免 Turn 取消流程把已失败的 Handoff 重新完成。
- Invocation 仍只允许从 queued/running 写失败或取消终态；已有终态不会被异步 catch 覆写。
- 取消失败逻辑未改：Session 精确取消失败仍恢复 `execution.cancelled=false`、保留 activity 与 active Runtime，允许重试且不发布 apology。

## 回归覆盖

1. **queued Participation**：另一个 Turn 占用同 Agent lane；取消后 queued Invocation 被移除、Session 不取消、Participant 保持 cancelled，lane 释放后不会晚到执行。
2. **running Participation**：只取消对应 Invocation Session；Turn/Invocation/Participant 一致 cancelled，无公开回复。
3. **running duplicate-check**：首个公开回复已合法落库；取消只命中 duplicate Invocation，第二位 Participant 保持 cancelled，无第二条/晚到回复。
4. **queued duplicate-check**：另一 Turn 占用第二 Agent lane；queued duplicate 从未进入 Session，取消不影响 blocker Turn，最终仅保留首个正常回复和另一 Turn 回复。
5. **取消失败重试**：原有 running Turn 回归继续通过，确认本轮 guard 未改变 active/retry 语义。

## 修改文件

- `server/application/channel-turn-coordinator.ts`
- `server/application/channel-turn-coordinator.test.ts`
- `.superpowers/sdd/2026-07-31-multi-agent-conversation-turns/task-5-report.md`

## TDD：真实 RED / GREEN

### Cycle 1：Participation 异步覆写

- RED：`npm test -- --run server/application/channel-turn-coordinator.test.ts`
- 结果：`2 failed / 18 passed`。queued Participant 被写为 `failed/participation_failed:Invocation ... was cancelled`；running Participant 被写为 `failed/participation_failed:Conversation invocation was cancelled`。

### Cycle 2：duplicate-check 异步覆写

- RED：加入 queued/running duplicate-check 后重跑同一命令。
- 结果：`4 failed / 18 passed`。两条 Participation 继续失败；queued/running duplicate Participant 均被写为 `skipped/duplicate_check_failed`。

### GREEN

- 实现共同 typed guard、duplicate cancellation sentinel 与 Participant 终态保护后，Coordinator `1 file / 22 tests passed`。
- 指定聚焦：Coordinator/Queue/Session `3 files / 42 tests passed`，无 warning 或 unhandled rejection。

## 完整验证

- 聚焦：`npm test -- --run server/application/channel-turn-coordinator.test.ts server/application/agent-invocation-queue.test.ts server/application/conversation-session-service.test.ts`
  - 结果：3 个测试文件、42 项测试通过，退出码 0。
- 完整测试：`npm test -- --run`
  - 结果：49 个测试文件、368 项测试通过，0 失败，退出码 0。
- Build：`npm run build`
  - 结果：`tsc --noEmit` 通过；Vite 转换 1801 modules 并成功生成产物，退出码 0。
- `git diff --check`：通过。

## 自审

- 四种 Invocation（Participation、duplicate-check、response、handoff-response）的 Queue/Session typed cancellation 使用同一 guard。
- Turn cancel 的 Participant/Invocation/Handoff 终态均为单调更新；取消 continuation 不会将 cancelled/failed 改写为 failed/skipped/completed。
- queued 路径不调用 Session；running 路径只传当前 invocationId；双 Turn 同 Agent 回归证明 ownership 隔离。
- 首个已落库的合法公开回复不被撤回；被取消 Agent 不发布 apology 或晚到回复。
- 全局 Queue priority、协议/Policy、migration 16 和 A6 范围均未改动。

## 风险

- typed cancellation 依赖两类本地 Error class 的 `instanceof`；当前 Queue、Session 与 Coordinator 共用同一模块实例，完整构建和测试均覆盖该运行方式。
- 已完成的首个公开回复在随后 duplicate-check 取消 Turn 时会保留，这是“只从未完成工作停止”的既有语义；被取消的后续 Agent 不会发布回复。
