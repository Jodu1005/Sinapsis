# 多 Agent 对话回合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前“每条消息选择一个 Agent”的聊天编排升级为职责预筛、候选自主判断、确定性发言顺序、受控 Handoff、多种提及模式和可恢复 Runtime Session。

**Architecture:** 保留现有消息 POST API 和 Runtime Adapter 端口，在其后新增持久化 `ConversationTurn` 聚合。纯函数负责匹配、排序和 Handoff 校验；`ChannelTurnCoordinator` 只编排状态；每个 Agent 使用独立优先级队列；`ConversationSessionService` 负责持久化和恢复 Runtime Session。频道时间线只展示公开回复，内部决策通过 Turn 详情和 SSE 暴露。

**Tech Stack:** TypeScript, Express, SQLite (`node:sqlite`), React, Vitest, Testing Library, Server-Sent Events.

## Global Constraints

- 设计规格以 `docs/superpowers/specs/2026-07-31-multi-agent-turns-and-dream-memory-design.md` 为唯一产品语义来源。
- 普通消息最多预筛 `3` 个候选，服务端硬上限 `5`；首轮最多 `2` 个 Agent 公开发言；一个 Turn 最多 `3` 轮。
- 单个显式 `@Agent` 跳过职责预筛并允许 Handoff；多个显式提及和 `@all` 并行回答且禁止自动 Handoff。
- Handoff 只能来自已经落库的公开 Agent 回复，并且目标必须是当前频道成员。
- 新人类消息优先于尚未开始的自动 Handoff，不中断已经开始生成的公开回复。
- Participation、重复检查、排序分数、结构化 JSON 和 Runtime 原始日志不得写入频道消息。
- 一个 Agent 的 Runtime 调用必须串行；不同 Agent 可以并行。
- Session 粒度固定为 `channelId + threadRootMessageId + agentId`，应用重启后优先恢复，失败后才冷启动。
- 现有 Task Runtime、任务队列和任务人工审核行为保持不变。
- 不修改或暂存现有未跟踪文件 `.codex/` 与 `src/.DS_Store`。

---

### Task 1: 建立对话领域模型、路由解析与职责预筛

**Files:**
- Create: `server/domain/conversation.ts`
- Create: `server/application/mention-router.ts`
- Create: `server/application/mention-router.test.ts`
- Create: `server/application/responsibility-matcher.ts`
- Create: `server/application/responsibility-matcher.test.ts`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`

**Interfaces:**

```ts
export type TurnMode = 'ordinary' | 'direct' | 'multi_direct' | 'all'
export type TurnStatus =
  | 'screening' | 'judging' | 'responding' | 'handoff'
  | 'completed' | 'cancelled' | 'failed'

export interface ConversationTurn {
  id: string
  channelId: string
  triggerMessageId: string
  threadRootMessageId: string | null
  mode: TurnMode
  status: TurnStatus
  currentRound: number
  maxRounds: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface MentionRoute {
  mode: TurnMode
  targetAgentIds: string[]
  unknownMentions: string[]
}

export interface ResponsibilityCandidate {
  agent: Agent
  score: number
  matchedDescriptors: string[]
}
```

`ServiceConfig` 新增：

```ts
maxParticipationCandidates: number       // 默认 3
maxInitialSpeakers: number               // 默认 2
maxConversationRounds: number            // 默认 3
maxHandoffTargetsPerReply: number         // 默认 2
participationProbeTimeoutMs: number       // 默认 30_000
duplicateCheckTimeoutMs: number           // 默认 30_000
conversationResponseTimeoutMs: number     // 默认 90_000
```

- [ ] **Step 1: 写出路由、匹配和配置的失败测试**

覆盖：

```ts
expect(routeMentions('@Newton 看一下', members)).toEqual({
  mode: 'direct',
  targetAgentIds: [newton.id],
  unknownMentions: [],
})
expect(routeMentions('@Newton @Clawd 各自回答', members).mode).toBe('multi_direct')
expect(routeMentions('@all 给出意见', members).mode).toBe('all')
expect(matchResponsibilities('修复 React 表单样式', members, 3)[0]?.agent.id).toBe(frontend.id)
expect(matchResponsibilities('随便聊聊', members, 3)).toEqual([])
expect(() => getServiceConfig({ SINAPSIS_MAX_PARTICIPATION_CANDIDATES: '6' }))
  .toThrow('must be between 1 and 5')
```

- [ ] **Step 2: 运行测试并确认缺少模块**

Run:

```bash
npm test -- server/application/mention-router.test.ts server/application/responsibility-matcher.test.ts server/config.test.ts
```

Expected: FAIL，因为领域类型、路由器、匹配器和新配置尚不存在。

- [ ] **Step 3: 实现精确提及解析**

`routeMentions` 必须：

- 同时识别 `identity` 和兼容字段 `mentionName`，输出始终是 Agent ID。
- 优先识别保留字 `@all`，不得把它当作普通 Agent。
- 对 Agent ID 去重并保持消息中的首次出现顺序。
- 只返回当前频道成员，未匹配名称写入 `unknownMentions`。
- 普通正文中出现名称但没有 `@` 时不算提及。

- [ ] **Step 4: 实现纯函数职责匹配和配置校验**

```ts
export function matchResponsibilities(
  body: string,
  agents: Agent[],
  limit: number,
): ResponsibilityCandidate[]
```

沿用现有中文 bigram、英文单词和完全包含评分规则，但移动到独立模块并返回命中依据。排序固定为 `score desc -> updatedAt asc -> id asc`，不读取 Agent 当前忙闲状态。

- [ ] **Step 5: 运行聚焦测试和类型检查**

Run:

```bash
npm test -- server/application/mention-router.test.ts server/application/responsibility-matcher.test.ts server/config.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/domain/conversation.ts server/application/mention-router.ts server/application/mention-router.test.ts server/application/responsibility-matcher.ts server/application/responsibility-matcher.test.ts server/config.ts server/config.test.ts
git commit -m "feat: add deterministic conversation routing"
```

### Task 2: 持久化 Turn、Invocation、Handoff 与 Conversation Session

**Files:**
- Modify: `server/domain/conversation.ts`
- Modify: `server/ports/repositories.ts`
- Modify: `server/adapters/sqlite/schema.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.test.ts`

**Interfaces:**

```ts
export interface TurnParticipant {
  id: string
  turnId: string
  agentId: string
  source: 'responsibility' | 'direct' | 'all' | 'handoff'
  rank: number
  matcherScore: number | null
  decision: 'pending' | 'speak' | 'silent' | 'skipped'
  confidence: number | null
  proposedAngle: string | null
  dependsOnAgentId: string | null
  speakingOrder: number | null
  status: 'candidate' | 'selected' | 'spoken' | 'failed' | 'skipped'
  reason: string | null
  createdAt: string
  updatedAt: string
}

export type InvocationKind =
  | 'participation' | 'response' | 'duplicate_check' | 'handoff_response'
export type InvocationStatus = 'queued' | 'running' | 'settled' | 'failed' | 'cancelled'
export type InvocationPriority =
  | 'human_direct' | 'human_ordinary' | 'participation'
  | 'duplicate_check' | 'automatic_handoff'

export interface AgentInvocation {
  id: string
  turnId: string
  agentId: string
  kind: InvocationKind
  priority: InvocationPriority
  round: number
  status: InvocationStatus
  idempotencyKey: string
  sourceInvocationId: string | null
  queuedAt: string
  startedAt: string | null
  completedAt: string | null
  errorCode: string | null
}

export interface ConversationHandoff {
  id: string
  turnId: string
  sourceInvocationId: string
  fromAgentId: string
  toAgentId: string
  question: string
  round: number
  status: 'queued' | 'accepted' | 'rejected' | 'completed'
  reason: string | null
  createdAt: string
}

export interface ConversationSession {
  id: string
  key: string
  channelId: string
  threadRootMessageId: string | null
  agentId: string
  runtime: RuntimeKind
  runtimeSessionId: string | null
  runtimeSessionFile: string | null
  status: 'ready' | 'active' | 'stale' | 'failed'
  lastMessageId: string | null
  lastUsedAt: string
  createdAt: string
  updatedAt: string
}
```

仓储新增：

```ts
createConversationTurn(input: CreateConversationTurnInput): ConversationTurn
getConversationTurn(turnId: string): ConversationTurn | undefined
updateConversationTurn(turnId: string, patch: ConversationTurnPatch): ConversationTurn
createTurnParticipant(input: CreateTurnParticipantInput): TurnParticipant
updateTurnParticipant(turnId: string, agentId: string, patch: ParticipantPatch): TurnParticipant
listTurnParticipants(turnId: string): TurnParticipant[]
createAgentInvocation(input: CreateAgentInvocationInput): AgentInvocation
updateAgentInvocation(invocationId: string, patch: InvocationPatch): AgentInvocation
listAgentInvocations(turnId: string): AgentInvocation[]
createConversationHandoff(input: CreateConversationHandoffInput): ConversationHandoff
listConversationHandoffs(turnId: string): ConversationHandoff[]
getConversationSession(key: string): ConversationSession | undefined
upsertConversationSession(input: UpsertConversationSessionInput): ConversationSession
listMessagesForConversation(channelId: string, threadRootMessageId: string | null): Message[]
getLastAgentSpokenAt(channelId: string, agentId: string): string | null
```

- [ ] **Step 1: 写 migration 15 和仓储契约的失败测试**

从 migration 14 数据库升级，断言旧消息仍存在，并覆盖：

```ts
const turn = repositories.createConversationTurn({
  channelId, triggerMessageId, threadRootMessageId: null,
  mode: 'ordinary', maxRounds: 3,
})
repositories.createTurnParticipant({
  turnId: turn.id, agentId, source: 'responsibility',
  rank: 0, matcherScore: 18,
})
repositories.upsertConversationSession({
  key: `${channelId}:timeline:${agentId}`,
  channelId, threadRootMessageId: null, agentId,
  runtime: 'pi', runtimeSessionId: 'session-1',
  runtimeSessionFile: null, status: 'ready', lastMessageId: triggerMessageId,
})
expect(repositories.getConversationTurn(turn.id)?.status).toBe('screening')
expect(repositories.listTurnParticipants(turn.id)).toHaveLength(1)
expect(repositories.getConversationSession(`${channelId}:timeline:${agentId}`)?.runtimeSessionId)
  .toBe('session-1')
```

- [ ] **Step 2: 运行仓储测试并确认失败**

Run:

```bash
npm test -- server/adapters/sqlite/sqlite-repositories.test.ts
```

Expected: FAIL，因为 migration 15 和仓储方法不存在。

- [ ] **Step 3: 添加 migration 15**

创建：

```sql
conversation_turns
turn_participants
agent_invocations
conversation_handoffs
conversation_sessions
```

约束必须包括：

- `conversation_turns.trigger_message_id` 唯一，保证同一人类消息只创建一个 Turn。
- `turn_participants` 主键为 `(turn_id, agent_id)`。
- `agent_invocations.idempotency_key` 唯一。
- `conversation_sessions.key` 主键。
- 所有 Agent、Channel、Message、Turn 外键启用。
- 为 `status + created_at`、`turn_id + sequence`、`agent_id + status` 建索引。

- [ ] **Step 4: 实现映射与原子更新**

Turn 创建、参与者创建和初始 Invocation 入队必须可在同一 `inTransaction` 中完成。所有枚举值在 TypeScript 层和 SQLite `CHECK` 中保持一致。`listMessagesForConversation` 返回当前 `context_reset_at` 之后的完整时间线或完整 Thread，不再固定截取八条。

- [ ] **Step 5: 运行仓储测试和完整迁移测试**

Run:

```bash
npm test -- server/adapters/sqlite/sqlite-repositories.test.ts
npm run build
```

Expected: PASS，migration 14 fixture 可无损升级。

- [ ] **Step 6: Commit**

```bash
git add server/domain/conversation.ts server/ports/repositories.ts server/adapters/sqlite/schema.ts server/adapters/sqlite/sqlite-repositories.ts server/adapters/sqlite/sqlite-repositories.test.ts
git commit -m "feat: persist conversation turns and sessions"
```

### Task 3: 定义结构化 Agent 协议和安全解析器

**Files:**
- Create: `server/application/agent-conversation-protocol.ts`
- Create: `server/application/agent-conversation-protocol.test.ts`
- Create: `server/application/participation-service.ts`
- Create: `server/application/participation-service.test.ts`
- Modify: `server/ports/runtime.ts`
- Modify: `server/adapters/runtime/fake-runtime-adapter.ts`

**Interfaces:**

```ts
export interface ParticipationDecision {
  decision: 'speak' | 'silent'
  confidence: number
  reason: string
  proposedAngle: string
  dependsOnAgentId: string | null
}

export interface PublicAgentResponse {
  reply: string
  handoffTo: Array<{ agentId: string; question: string }>
}

export interface DuplicateDecision {
  decision: 'speak' | 'silent'
  reason: string
  revisedAngle: string | null
}

export interface RuntimeConversationCall {
  kind: InvocationKind
  prompt: string
  initialMessage: string
}
```

- [ ] **Step 1: 写失败测试覆盖严格解析**

```ts
expect(parseParticipation('{"decision":"speak","confidence":0.8,"reason":"前端职责","proposedAngle":"检查表单","dependsOnAgentId":null}'))
  .toEqual({
    decision: 'speak',
    confidence: 0.8,
    reason: '前端职责',
    proposedAngle: '检查表单',
    dependsOnAgentId: null,
  })
expect(() => parseParticipation('{"decision":"handoff"}')).toThrow()
expect(parsePublicResponse('普通文本')).toEqual({ reply: '普通文本', handoffTo: [] })
expect(parsePublicResponse('{"reply":"完成","handoffTo":[{"agentId":"a2","question":"请复核"}]}'))
  .toEqual(expect.objectContaining({ reply: '完成' }))
```

还要覆盖 JSON fence、额外字段、空回复、超长 reason、无效 confidence 和把普通 `@名称` 误判为 Handoff。

- [ ] **Step 2: 运行协议测试并确认失败**

Run:

```bash
npm test -- server/application/agent-conversation-protocol.test.ts server/application/participation-service.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现协议解析和 Prompt Builder**

解析器只接受已知字段并限制：

- `confidence` 在 `0..1`。
- `reason` 最长 `500` 字符。
- `proposedAngle` 和 `revisedAngle` 最长 `500` 字符。
- `dependsOnAgentId` 必须为空或当前候选集合中的 Agent。
- `reply` 最长 `20_000` 字符且非空。
- 单次 `handoffTo` 最多两个目标。
- Participation 只能返回 `speak` 或 `silent`，不能提前 Handoff。

`ParticipationService.decide` 接收候选职责、当前消息和频道摘要，使用 `participationProbeTimeoutMs`；超时返回 `{ decision: 'silent', reason: 'timeout' }`，不得中断其他候选。

- [ ] **Step 4: 为 Runtime 请求增加可选调用元数据**

在不改变 Task Runtime 的前提下扩展：

```ts
export interface RuntimeTaskRequest {
  // existing fields
  conversation?: {
    turnId: string
    invocationId: string
    kind: InvocationKind
    expectedOutput: 'participation' | 'public_response' | 'duplicate'
  }
}
```

Fake Adapter 保存该字段，便于 Coordinator 测试区分探针和正式回答。

- [ ] **Step 5: 运行测试和类型检查**

Run:

```bash
npm test -- server/application/agent-conversation-protocol.test.ts server/application/participation-service.test.ts server/adapters/runtime
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/application/agent-conversation-protocol.ts server/application/agent-conversation-protocol.test.ts server/application/participation-service.ts server/application/participation-service.test.ts server/ports/runtime.ts server/adapters/runtime/fake-runtime-adapter.ts
git commit -m "feat: add structured agent conversation protocol"
```

### Task 4: 实现每 Agent 优先级队列和可恢复 Session 服务

**Files:**
- Create: `server/application/agent-invocation-queue.ts`
- Create: `server/application/agent-invocation-queue.test.ts`
- Create: `server/application/conversation-session-service.ts`
- Create: `server/application/conversation-session-service.test.ts`
- Create: `server/application/context-assembler.ts`
- Create: `server/application/context-assembler.test.ts`
- Modify: `server/application/conversation-coordinator.ts`
- Modify: `server/application/conversation-coordinator.test.ts`

**Interfaces:**

```ts
export interface QueuedInvocation<T> {
  id: string
  agentId: string
  priority: InvocationPriority
  sequence: number
  run(): Promise<T>
}

export class AgentInvocationQueue {
  enqueue<T>(invocation: QueuedInvocation<T>): Promise<T>
  cancel(predicate: (invocation: QueuedInvocation<unknown>) => boolean): void
  snapshot(agentId: string): { running: boolean; queued: number }
}

export class ConversationSessionService {
  invoke(input: ConversationSessionInvocation): Promise<ConversationSessionResult>
  cancelChannel(channelId: string): Promise<void>
  cancelAgentInChannel(channelId: string, agentId: string): Promise<void>
}

export class ContextAssembler {
  assemble(input: {
    channelId: string
    threadRootMessageId: string | null
    currentMessageId: string
    tokenBudget: number
  }): { recentMessages: Message[] }
  render(context: { recentMessages: Message[] }): string
}
```

- [ ] **Step 1: 写队列顺序、冷启动上下文和 Session 恢复的失败测试**

断言：

- 同一 Agent 同时只运行一个调用。
- 不同 Agent 可以同时运行。
- 已排队的 `human_direct` 排在未开始的 `automatic_handoff` 前。
- 同优先级按全局 sequence FIFO。
- 数据库有 Runtime Session ID 时先调用 `resume` 再 `sendInput`。
- resume 失败会把旧 Session 标记 `stale`，冷启动新 Session，并保存新 `session` 事件。
- `settled` 后 Session 保持 `ready`，不会从内存映射删除。
- Timeline 冷启动按时间顺序读取 `context_reset_at` 之后的完整公开消息，再按 token budget 从旧到新裁剪。
- Thread 冷启动只读取 Root 和该 Thread 回复，不混入 Timeline 的其他消息。
- 已删除消息、Runtime Artifact 和 Turn 内部决策不进入上下文。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/agent-invocation-queue.test.ts server/application/conversation-session-service.test.ts server/application/context-assembler.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现稳定优先级队列**

优先级固定为：

```ts
human_direct > human_ordinary > participation > duplicate_check > automatic_handoff
```

已经开始的调用不可被抢占。取消只影响匹配的排队项和当前 Runtime Session；取消失败时保持可重试状态，不伪装成功。

- [ ] **Step 4: 从旧 Coordinator 提取 Session 生命周期**

`ConversationSessionService` 负责：

- 生成稳定 key：`${channelId}:${threadRootMessageId ?? 'timeline'}:${agentId}`。
- 启动、resume、sendInput、cancel 和 Runtime event 聚合。
- 接收 `session` event 后立即持久化 Session ID/File。
- 仅返回最终可展示文本和协议解析结果，不写频道消息。
- 冷启动上下文由调用者传入，不在服务内读取“最近八条”。

- [ ] **Step 5: 实现基础 ContextAssembler 并移除固定八条逻辑**

本计划中的基础版本只组装公开消息，使用稳定标题和字符预算。它必须完整读取当前 Timeline 或 Thread，再从最新消息向前保留到预算上限。Dream 计划会在同一接口前面增加已确认 Global Memory、Channel Memory 和 Thread Summary 层。

旧 `ConversationCoordinator` 暂时委托 SessionService 和 ContextAssembler，以保持现有测试和 API 可运行。

- [ ] **Step 6: 运行聚焦测试及旧 Coordinator 回归**

Run:

```bash
npm test -- server/application/agent-invocation-queue.test.ts server/application/conversation-session-service.test.ts server/application/context-assembler.test.ts server/application/conversation-coordinator.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/application/agent-invocation-queue.ts server/application/agent-invocation-queue.test.ts server/application/conversation-session-service.ts server/application/conversation-session-service.test.ts server/application/context-assembler.ts server/application/context-assembler.test.ts server/application/conversation-coordinator.ts server/application/conversation-coordinator.test.ts
git commit -m "refactor: isolate agent queues and conversation sessions"
```

### Task 5: 实现 HandoffPolicy 与普通消息的确定性回合

**Files:**
- Create: `server/application/handoff-policy.ts`
- Create: `server/application/handoff-policy.test.ts`
- Create: `server/application/channel-turn-coordinator.ts`
- Create: `server/application/channel-turn-coordinator.test.ts`
- Modify: `server/application/conversation-coordinator.ts`
- Modify: `server/application/conversation-coordinator.test.ts`

**Interfaces:**

```ts
export interface HandoffValidationContext {
  turn: ConversationTurn
  fromAgentId: string
  channelMemberAgentIds: string[]
  spokenAgentIds: string[]
  handoffEdges: Array<{ fromAgentId: string; toAgentId: string }>
}

export interface HandoffDecision {
  accepted: Array<{ agentId: string; question: string }>
  rejected: Array<{ agentId: string; reason: string }>
}

export class ChannelTurnCoordinator {
  dispatch(message: Message): Promise<ConversationTurn>
  cancel(turnId: string): Promise<ConversationTurn>
  getActiveStates(channelId: string): TurnActivity[]
}
```

- [ ] **Step 1: 写 Handoff 和普通回合失败测试**

覆盖：

- 非成员、自己、已发言 Agent、重复边、`A -> B -> A`、第四轮和第三个目标被拒绝。
- 普通消息预筛最多三个候选，并行 Participation。
- 只选 `speak`，按 `dependsOnAgentId` 拓扑约束，再按 `matcherScore desc -> confidence desc -> queueAvailable desc -> lastSpokenAt asc -> agentId asc`。
- 首个 Agent 公开回复落库后，第二个 Agent 读取该回复做 duplicate check。
- duplicate check 为 `silent` 时不发布占位消息。
- 两个候选均失败时 Turn 仍以可解释的 `completed` 结束。
- 有效 Handoff 在来源回复落库后进入下一轮。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/handoff-policy.test.ts server/application/channel-turn-coordinator.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现纯 HandoffPolicy**

结构化 `agentId` 是唯一可信路由依据。可见回复中的 `@Agent` 仅用于人类理解，不触发后端路由。每个拒绝原因持久化在 Handoff 记录中，供 Turn 详情查看。

- [ ] **Step 4: 实现普通消息状态机**

执行顺序：

```text
screening
-> candidates persisted
-> participation probes in parallel
-> deterministic speaker selection
-> first public response
-> duplicate check for each later selected speaker
-> validated handoff worklist
-> completed
```

每次状态变化、参与者决策、Invocation 和 Handoff 都先持久化，再发 SSE。Agent 回复通过 `ChannelMessageService.postAgent` 写入，并携带当前 Thread root。

跨来源排序固定为“人类直接提及 > 有效 Handoff > 普通候选”；普通候选内部再使用依赖、Matcher 分数、置信度、队列可用性、最近较少发言和 Agent ID。依赖形成环时忽略环内依赖并记录原因，不能让 Turn 卡死。

- [ ] **Step 5: 将旧入口改为兼容门面**

保留：

```ts
ConversationCoordinator.dispatch(channelId: string, message: Message): Promise<void>
```

内部调用 `ChannelTurnCoordinator.dispatch(message)`。现有 `getTypingAgentIds` 由新的 `getActiveStates` 派生，直到前端完成迁移。

- [ ] **Step 6: 运行回归测试**

Run:

```bash
npm test -- server/application/handoff-policy.test.ts server/application/channel-turn-coordinator.test.ts server/application/conversation-coordinator.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/application/handoff-policy.ts server/application/handoff-policy.test.ts server/application/channel-turn-coordinator.ts server/application/channel-turn-coordinator.test.ts server/application/conversation-coordinator.ts server/application/conversation-coordinator.test.ts
git commit -m "feat: orchestrate deterministic multi-agent turns"
```

### Task 6: 完成单提及、多提及和 `@all` 模式

**Files:**
- Modify: `server/application/channel-turn-coordinator.ts`
- Modify: `server/application/channel-turn-coordinator.test.ts`
- Modify: `server/application/mention-router.ts`
- Modify: `server/application/mention-router.test.ts`
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`

- [ ] **Step 1: 写三种显式路由的失败测试**

断言：

- 单 `@Agent` 跳过 Participation，目标忙碌时进入其队列，完成后允许 Handoff。
- 多个显式提及只调用被点名 Agent，正式回复并行，禁止 Handoff。
- `@all` 调用当前频道所有成员，不受首轮最多两个限制。
- `summit` 的 `@all` 动态读取所有现有 Agent。
- 单个 Agent 失败不影响其他 Agent 回复。
- `@all` 和多提及输出中的 `handoffTo` 被记录为 rejected，不继续调用。
- 未知提及返回 `400`，不创建半成品 Turn。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/channel-turn-coordinator.test.ts server/application/mention-router.test.ts server/app.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现显式模式分支**

`ChannelTurnCoordinator.dispatch` 在创建 Turn 前完成 MentionRoute 校验。并行模式使用 `Promise.allSettled`，按照人类提及顺序或频道成员稳定顺序落库最终消息，避免 Runtime 完成速度导致时间线随机抖动。

- [ ] **Step 4: 简化 App 消息路由**

`server/app.ts` 不再用本地 `findMentionedAgent` 决定普通聊天 Agent。Task 绑定消息仍走现有任务输入路径；非 Task 消息统一交给 ConversationCoordinator。删除重复的 `exactMention` 和 `findMentionedAgent`，防止 App 与 Coordinator 路由语义分叉。

- [ ] **Step 5: 运行 API 和编排测试**

Run:

```bash
npm test -- server/application/channel-turn-coordinator.test.ts server/app.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/application/channel-turn-coordinator.ts server/application/channel-turn-coordinator.test.ts server/application/mention-router.ts server/application/mention-router.test.ts server/app.ts server/app.test.ts
git commit -m "feat: support explicit and all-agent conversation modes"
```

### Task 7: 暴露 Turn 详情、活动状态与 SSE

**Files:**
- Modify: `server/domain/events.ts`
- Modify: `server/ports/repositories.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/adapters/sse/sse-domain-event-publisher.ts`
- Modify: `server/adapters/sse/sse-domain-event-publisher.test.ts`
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`

**APIs:**

```text
POST /api/channels/:channelId/messages
GET  /api/channels/:channelId/turns/:turnId
POST /api/channels/:channelId/turns/:turnId/cancel
GET  /api/bootstrap
```

Bootstrap 新增：

```ts
activeTurnsByChannel: Record<string, Array<{
  turnId: string
  agentId: string | null
  phase: 'screening' | 'judging' | 'queued' | 'preparing' | 'handoff'
  queuePosition: number | null
}>>
```

- [ ] **Step 1: 写 API 与 SSE 失败测试**

检查 Turn 详情包含 participants、invocations、handoffs，但不包含 Runtime 原始日志、环境变量或私有 Prompt。检查以下事件：

```text
conversation.turn_created
conversation.turn_updated
conversation.participant_updated
conversation.invocation_updated
conversation.handoff_created
conversation.turn_completed
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/app.test.ts server/adapters/sse/sse-domain-event-publisher.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现只读详情和幂等取消**

取消已终态 Turn 返回当前 Turn；取消活动 Turn 会取消未开始 Invocation 和相关 Runtime 调用，并把参与者/Invocation 状态持久化为 `cancelled`。

- [ ] **Step 4: 将活动状态加入 Bootstrap**

活动状态来自持久化 Invocation 加队列快照，不再仅依赖进程内 `executions` Map。应用刚重启时，未恢复的 `running` Invocation 显示为 `queued`，恢复启动后切换为 `preparing`。

- [ ] **Step 5: 运行 API、SSE 和类型检查**

Run:

```bash
npm test -- server/app.test.ts server/adapters/sse/sse-domain-event-publisher.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/domain/events.ts server/ports/repositories.ts server/adapters/sqlite/sqlite-repositories.ts server/adapters/sse/sse-domain-event-publisher.ts server/adapters/sse/sse-domain-event-publisher.test.ts server/app.ts server/app.test.ts
git commit -m "feat: expose conversation turn activity"
```

### Task 8: 在频道界面呈现多 Agent 活动和 Turn 详情

**Files:**
- Modify: `src/domain/workspace-view.ts`
- Modify: `src/api/client.ts`
- Modify: `src/api/use-workspace-events.ts`
- Modify: `src/api/use-workspace-events.test.tsx`
- Modify: `src/ui/MessageComposer.tsx`
- Modify: `src/ui/MessageComposer.test.tsx`
- Modify: `src/ui/ChannelTimeline.tsx`
- Modify: `src/ui/ChannelTimeline.test.tsx`
- Create: `src/ui/ConversationTurnDetail.tsx`
- Create: `src/ui/ConversationTurnDetail.test.tsx`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: 写界面失败测试**

覆盖：

- 输入 `@` 时建议列表包含 `@all` 和当前频道成员。
- `@all` 只出现一次并支持方向键、Enter 选择。
- 时间线显示“正在筛选职责”“Newton 正在判断是否参与”“Clawd 排队中（第 2 位）”“Newton 正在准备回复”。
- Agent 正式回复出现后对应准备状态消失。
- 点击活动状态或 Turn 标记可在右侧查看候选、理由、轮次、Handoff 路径和失败。
- 页面不渲染 Participation JSON、Prompt 或 Runtime 原始输出。

- [ ] **Step 2: 运行前端测试并确认失败**

Run:

```bash
npm test -- src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 扩展前端类型和 API**

```ts
export interface TurnActivityView {
  turnId: string
  agentId: string | null
  phase: 'screening' | 'judging' | 'queued' | 'preparing' | 'handoff'
  queuePosition: number | null
}

WorkspaceApi.getConversationTurn(channelId: string, turnId: string): Promise<ConversationTurnDetailView>
WorkspaceApi.cancelConversationTurn(channelId: string, turnId: string): Promise<void>
```

订阅所有 `conversation.*` SSE 并复用现有节流刷新。

- [ ] **Step 4: 实现紧凑活动反馈和详情面板**

活动反馈放在时间线底部，不创建嵌套卡片。多个 Agent 同时活动时按 Turn 和队列顺序稳定显示。右侧详情复用现有 Context 面板宽度和视觉语言，默认折叠内部失败详情。

- [ ] **Step 5: 运行前端测试和 Build**

Run:

```bash
npm test -- src/api/use-workspace-events.test.tsx src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.test.tsx
npm run build
```

Expected: PASS，移动端无按钮文字溢出。

- [ ] **Step 6: Commit**

```bash
git add src/domain/workspace-view.ts src/api/client.ts src/api/use-workspace-events.ts src/api/use-workspace-events.test.tsx src/ui/MessageComposer.tsx src/ui/MessageComposer.test.tsx src/ui/ChannelTimeline.tsx src/ui/ChannelTimeline.test.tsx src/ui/ConversationTurnDetail.tsx src/ui/ConversationTurnDetail.test.tsx src/ui/WorkspaceShell.tsx src/ui/WorkspaceShell.test.tsx src/styles.css
git commit -m "feat: show multi-agent turn progress"
```

### Task 9: 重启恢复、端到端回归与文档同步

**Files:**
- Create: `server/integration/multi-agent-conversation-flow.test.ts`
- Modify: `server/main.ts`
- Modify: `server/main.test.ts`
- Modify: `docs/raft-control-room-design.md`
- Modify: `specs/feature-tree.md`

- [ ] **Step 1: 写集成失败测试**

测试真实 SQLite、Fake Runtime 和 Express：

1. 普通消息触发两个候选，第二个做重复检查。
2. 第一个回复 Handoff 给第三个 Agent，第三个在第二轮回答。
3. 重建 App/Coordinator 后，同一频道同一 Agent 从持久化 Session 恢复。
4. resume 失败时冷启动，完整频道或 Thread 历史仍通过 ContextAssembler 注入。
5. 多提及和 `@all` 并行失败隔离。
6. 原始 Artifact 不进入频道或 Turn 详情。

- [ ] **Step 2: 运行集成测试并确认失败**

Run:

```bash
npm test -- server/integration/multi-agent-conversation-flow.test.ts server/main.test.ts
```

Expected: FAIL，直到启动装配注入全部新服务。

- [ ] **Step 3: 完成应用装配与启动恢复**

`server/main.ts` 创建单例 Queue、SessionService、ParticipationService、HandoffPolicy 和 ChannelTurnCoordinator。启动时将残留 `running` Invocation 原子恢复为 `queued`，再按优先级恢复；已取消或已完成 Turn 不恢复。

- [ ] **Step 4: 更新架构文档和 Feature Tree**

记录：

- 四种消息模式。
- Session key 和重启恢复语义。
- Handoff 的可见文本与结构化路由区别。
- Turn 状态与用户可见状态。
- Dream Memory 仍由下一份计划实现。

- [ ] **Step 5: 运行全套验证**

Run:

```bash
npm test -- --run
npm run build
```

Expected: 全部 PASS。

- [ ] **Step 6: 启动服务并做浏览器验收**

Run:

```bash
npm run dev
```

使用浏览器验证桌面与窄屏：

- 普通消息出现筛选、判断、排队、准备和最终回复。
- `@Agent`、多提及、`@all` 路由正确。
- Thread 中的 Agent 回复留在 Thread。
- 刷新页面后当前频道保留，活动 Turn 状态可恢复。
- 控制台无错误，界面无重叠。

- [ ] **Step 7: Commit**

```bash
git add server/integration/multi-agent-conversation-flow.test.ts server/main.ts server/main.test.ts docs/raft-control-room-design.md specs/feature-tree.md
git commit -m "test: verify multi-agent conversation turns"
```

## Completion Gate

- [ ] 所有九个任务各自有通过的聚焦测试和独立 Commit。
- [ ] `npm test -- --run` 与 `npm run build` 通过。
- [ ] 浏览器完成普通、单提及、多提及、`@all`、Handoff、Thread 和刷新恢复验收。
- [ ] 频道中没有内部 JSON、私有 Prompt 或 Runtime 原始日志。
- [ ] Task Runtime 与人工审核回归通过。
- [ ] 完成本计划后，才能开始 `2026-07-31-dream-memory.md`。
