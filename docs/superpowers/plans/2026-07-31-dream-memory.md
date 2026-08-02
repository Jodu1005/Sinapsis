# Dream Memory 与人工审核中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在多 Agent 回合数据之上增加可追溯、需人工确认的 Global Memory、Channel Memory、Thread Summary，以及每日自动和手动触发的 Dream 提取流程。

**Architecture:** Dream 是独立维护队列，不占用频道 Agent 队列。`DreamScheduler` 按频道水位增量创建 Run，`MemoryConsolidator` 使用受限结构化协议提取候选，`MemoryReviewService` 负责人工接受、忽略和归档。只有已接受 Memory 能进入 `ContextAssembler`；候选、原始日志和敏感信息永不进入 Agent Prompt。

**Tech Stack:** TypeScript, Express, SQLite (`node:sqlite`), React, Vitest, Testing Library, Server-Sent Events.

## Global Constraints

- 必须先完成并通过 `docs/superpowers/plans/2026-07-31-multi-agent-conversation-turns.md`。
- Dream 默认每天 `03:00` 按配置时区运行，调度必须可注入 Clock，测试不得等待真实时间。
- Dream 只读取已公开、已送达且未删除的频道消息和 Turn 结果；不读取私有推理、Participation Prompt、Runtime 原始日志、Artifact 内容或环境变量。
- 无新增消息时不调用 LLM；有消息但无候选时记录成功 no-op。
- 所有 MemoryCandidate 必须由人类确认，才能成为可注入 Prompt 的 Memory。
- Global Memory 是整个本机 Control Room 范围的已确认偏好与规范；Channel Memory 只属于一个 Channel；Thread Summary 只属于一个 Thread。
- 人工接受候选时可以修改 scope 和内容，修改后的最终值与原提取值都保留审计。
- Memory 删除是软归档，不物理删除来源关系。
- 相同 Dream Run、频道水位和内容哈希必须幂等。
- 手动 Dream 支持全部活跃频道或一个指定频道；已归档频道默认不参与。
- 不修改或暂存现有未跟踪文件 `.codex/` 与 `src/.DS_Store`。

---

### Task 1: 持久化 Dream Run、候选、Memory 和来源

**Files:**
- Create: `server/domain/memory.ts`
- Modify: `server/ports/repositories.ts`
- Modify: `server/adapters/sqlite/schema.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.test.ts`

**Interfaces:**

```ts
export type MemoryScope = 'global' | 'channel'
export type MemoryKind = 'preference' | 'decision' | 'constraint' | 'fact' | 'workflow'
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'ignored' | 'superseded'
export type DreamRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DreamRun {
  id: string
  scope: 'channel'
  scopeId: string
  trigger: 'scheduled' | 'manual'
  status: DreamRunStatus
  fromMessageCreatedAt: string | null
  fromMessageId: string | null
  toMessageCreatedAt: string | null
  toMessageId: string | null
  candidateCount: number
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface MemoryCandidate {
  id: string
  dreamRunId: string
  proposedScope: MemoryScope
  channelId: string | null
  kind: MemoryKind
  proposedContent: string
  rationale: string
  confidence: number
  importance: number
  contentHash: string
  status: MemoryCandidateStatus
  reviewedContent: string | null
  reviewedScope: MemoryScope | null
  reviewedAt: string | null
  createdAt: string
}

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  channelId: string | null
  kind: MemoryKind
  content: string
  contentHash: string
  status: 'active' | 'archived'
  sourceCandidateId: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
```

仓储新增：

```ts
createDreamRun(input: CreateDreamRunInput): DreamRun
updateDreamRun(runId: string, patch: DreamRunPatch): DreamRun
getDreamRun(runId: string): DreamRun | undefined
listDreamRuns(filter?: DreamRunFilter): DreamRun[]
getDreamWatermark(channelId: string): DreamWatermark | undefined
createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate
getMemoryCandidate(candidateId: string): MemoryCandidate | undefined
listMemoryCandidates(filter?: MemoryCandidateFilter): MemoryCandidate[]
reviewMemoryCandidate(input: ReviewMemoryCandidateInput): MemoryCandidate
createMemoryFromCandidate(input: CreateMemoryFromCandidateInput): MemoryRecord
listAcceptedMemories(scope: MemoryScope, channelId?: string): MemoryRecord[]
updateMemory(memoryId: string, content: string): MemoryRecord
archiveMemory(memoryId: string, occurredAt: Date): MemoryRecord
listDreamSourceMessages(runId: string): Message[]
```

- [ ] **Step 1: 写 migration 19 的失败测试**

从已完成 migration 15 的 fixture 升级，覆盖：

```ts
const run = repositories.createDreamRun({
  scope: 'channel', scopeId: channelId, trigger: 'manual',
  from: null, to: { createdAt: message.createdAt, id: message.id },
})
const candidate = repositories.createMemoryCandidate({
  dreamRunId: run.id,
  proposedScope: 'channel',
  channelId,
  kind: 'fact',
  proposedContent: '前端使用 React。',
  rationale: '多次讨论确认',
  confidence: 0.92,
  importance: 0.8,
  sourceMessageIds: [message.id],
})
expect(repositories.listMemoryCandidates({ status: 'pending' })).toHaveLength(1)
expect(repositories.listDreamSourceMessages(run.id).map((item) => item.id))
  .toEqual([message.id])
```

同时断言不能创建 `scope = channel` 但 `channelId = null` 的记录，也不能把其他频道消息登记为来源。

- [ ] **Step 2: 运行仓储测试并确认失败**

Run:

```bash
npm test -- server/adapters/sqlite/sqlite-repositories.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 添加 migration 19**

迁移编号 16-18 已分别用于 Handoff、Turn 终态扩展和 Turn 恢复租约/幂等结果；Dream 从 19 开始。

创建：

```sql
dream_runs
dream_run_sources
memory_candidates
memory_candidate_sources
memories
memory_sources
thread_summaries
```

关键约束：

- `dream_runs(channel_id, to_message_created_at, to_message_id)` 唯一，保证水位幂等。
- `memory_candidates(dream_run_id, content_hash, proposed_scope, channel_id)` 唯一。
- `memories.content_hash` 在相同 scope/channel 的未归档记录中唯一。
- `memory_sources` 和 `memory_candidate_sources` 保留来源消息与 Turn。
- `thread_summaries` 主键为 `(channel_id, thread_root_message_id)`。

- [ ] **Step 4: 实现事务化审核与来源继承**

接受候选必须在一个事务中：

1. 校验候选仍为 `pending`。
2. 创建或复用相同 scope/content hash 的 Memory。
3. 从 Candidate 复制全部来源关系。
4. 将候选更新为 `accepted`。
5. 将相同 scope 的重复候选更新为 `superseded`。
6. 发布 `memory.candidate_reviewed` 与 `memory.changed`。

- [ ] **Step 5: 运行仓储测试和 Build**

Run:

```bash
npm test -- server/adapters/sqlite/sqlite-repositories.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/domain/memory.ts server/ports/repositories.ts server/adapters/sqlite/schema.ts server/adapters/sqlite/sqlite-repositories.ts server/adapters/sqlite/sqlite-repositories.test.ts
git commit -m "feat: persist dream memory candidates"
```

### Task 2: 扩展 ContextAssembler 与 Thread Summary

**Files:**
- Modify: `server/application/context-assembler.ts`
- Modify: `server/application/context-assembler.test.ts`
- Create: `server/application/thread-summary-service.ts`
- Create: `server/application/thread-summary-service.test.ts`
- Modify: `server/application/channel-turn-coordinator.ts`
- Modify: `server/application/channel-turn-coordinator.test.ts`

**Interfaces:**

```ts
export interface ConversationContext {
  globalMemory: MemoryRecord[]
  channelMemory: MemoryRecord[]
  threadSummary: string | null
  recentMessages: Message[]
}

export class ContextAssembler {
  assemble(input: {
    channelId: string
    threadRootMessageId: string | null
    currentMessageId: string
    tokenBudget: number
  }): ConversationContext
  render(context: ConversationContext): string
}

export class ThreadSummaryService {
  refresh(channelId: string, threadRootMessageId: string): Promise<ThreadSummary>
}
```

- [ ] **Step 1: 写上下文分层和预算的失败测试**

断言 Prompt 顺序固定：

```text
系统与 Agent 职责
-> 已确认 Global Memory
-> 已确认 Channel Memory
-> Thread Summary
-> 最近公开消息
-> 当前调用指令
```

还要覆盖：

- `pending`、`ignored`、`superseded` Candidate 永不进入 Prompt。
- 已归档 Memory 不进入 Prompt。
- Channel A Memory 不进入 Channel B。
- Timeline 调用不注入 Thread Summary。
- 超出预算时先缩减最近消息，再缩减 Summary；已确认 Memory 按更新时间和来源质量保留。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/context-assembler.test.ts server/application/thread-summary-service.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 扩展 ContextAssembler**

禁止简单拼接任意数据库 JSON。每一层使用明确标题、转义边界和字符预算。Memory 内容视为历史参考，不得覆盖系统安全指令。

- [ ] **Step 4: 实现增量 Thread Summary**

Thread Summary 只基于该 Thread 的公开消息，并保存 `throughMessageCreatedAt + throughMessageId` 水位。更新失败时保留旧 Summary，当前对话退化为旧 Summary 加新消息，不能阻断 Agent 回答。

- [ ] **Step 5: 将完整 ContextAssembler 接入所有对话调用**

Participation、正式回复、重复检查和 Handoff Response 使用同一基础上下文，但添加各自调用指令。已有可恢复 Runtime Session 仍发送当前增量消息；只有冷启动或 Session 恢复失败时渲染完整上下文。

- [ ] **Step 6: 运行聚焦与 Coordinator 回归**

Run:

```bash
npm test -- server/application/context-assembler.test.ts server/application/thread-summary-service.test.ts server/application/channel-turn-coordinator.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add server/application/context-assembler.ts server/application/context-assembler.test.ts server/application/thread-summary-service.ts server/application/thread-summary-service.test.ts server/application/channel-turn-coordinator.ts server/application/channel-turn-coordinator.test.ts
git commit -m "feat: assemble confirmed memory context"
```

### Task 3: 实现 MemoryConsolidator 的安全提取与去重

**Files:**
- Create: `server/application/memory-consolidation-protocol.ts`
- Create: `server/application/memory-consolidation-protocol.test.ts`
- Create: `server/application/memory-consolidator.ts`
- Create: `server/application/memory-consolidator.test.ts`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`

**Interfaces:**

```ts
export interface ProposedMemory {
  scope: MemoryScope
  kind: MemoryKind
  content: string
  rationale: string
  confidence: number
  importance: number
  sourceMessageIds: string[]
}

export interface MemoryConsolidationResult {
  candidates: ProposedMemory[]
}

export class MemoryConsolidator {
  consolidate(input: {
    channel: Channel
    messages: Message[]
    turns: ConversationTurnDetail[]
    acceptedMemories: MemoryRecord[]
  }): Promise<MemoryCandidate[]>
}
```

配置新增：

```ts
dreamRuntime: RuntimeKind
dreamModel: string
dreamTimeoutMs: number        // 默认 120_000
maxDreamCandidatesPerRun: number // 默认 20，硬上限 50
```

- [ ] **Step 1: 写协议和过滤失败测试**

覆盖：

- 空数组是合法 no-op。
- 来源 ID 必须属于当前输入集合。
- 最多返回配置数量的 Candidate。
- 秘钥、Token、Cookie、`.env` 值、私有路径凭据被拒绝。
- 临时状态、一次性报错和未经确认猜测被拒绝。
- 与已接受 Memory 完全重复时不创建 Candidate。
- 内容冲突时创建新 Candidate，并在 rationale 标注潜在冲突，等待人工决定。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/memory-consolidation-protocol.test.ts server/application/memory-consolidator.test.ts server/config.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现严格结构化解析**

只接受：

```json
{
  "candidates": [
    {
      "scope": "global",
      "kind": "preference",
      "content": "用户偏好中文界面。",
      "rationale": "在多个频道重复确认。",
      "confidence": 0.94,
      "importance": 0.8,
      "sourceMessageIds": ["message-id"]
    }
  ]
}
```

去除 Markdown fence 后解析，拒绝额外顶层字段、未知 scope/kind、超出 `0..1` 的 confidence/importance、空内容和伪造来源。对内容做规范化后计算 SHA-256 hash。

- [ ] **Step 4: 实现 Consolidator**

Dream 使用独立 Runtime 请求和独立工作目录 `${dataDir}/dream/<runId>`，不得复用任何 Agent 的 Channel Session。Runtime Artifact 只作为本机受控证据保存，不写消息或 Candidate。

- [ ] **Step 5: 运行测试和 Build**

Run:

```bash
npm test -- server/application/memory-consolidation-protocol.test.ts server/application/memory-consolidator.test.ts server/config.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/application/memory-consolidation-protocol.ts server/application/memory-consolidation-protocol.test.ts server/application/memory-consolidator.ts server/application/memory-consolidator.test.ts server/config.ts server/config.test.ts
git commit -m "feat: consolidate memory candidates safely"
```

### Task 4: 实现增量 Dream Scheduler 与独立维护队列

**Files:**
- Create: `server/ports/clock.ts`
- Create: `server/application/dream-scheduler.ts`
- Create: `server/application/dream-scheduler.test.ts`
- Create: `server/application/dream-run-service.ts`
- Create: `server/application/dream-run-service.test.ts`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`
- Modify: `server/main.ts`
- Modify: `server/main.test.ts`

**Interfaces:**

```ts
export interface Clock {
  now(): Date
  setTimeout(callback: () => void, delayMs: number): { cancel(): void }
}

export class DreamRunService {
  enqueue(input: { channelId: string; trigger: 'scheduled' | 'manual' }): DreamRun
  enqueueAllActive(trigger: 'scheduled' | 'manual'): DreamRun[]
  waitFor(runId: string): Promise<DreamRun>
}

export class DreamScheduler {
  start(): void
  stop(): void
  nextRunAt(from: Date): Date
}
```

配置新增：

```ts
dreamEnabled: boolean       // 默认 true
dreamTime: string           // 默认 "03:00"
dreamTimeZone: string       // 默认 "Asia/Shanghai"，IANA 名称
dreamMaintenanceConcurrency: number // 默认 1
```

- [ ] **Step 1: 写时间、水位和幂等失败测试**

使用 Fake Clock 覆盖：

- `Asia/Shanghai` 每天 03:00，跨日和夏令时地区计算正确。
- 同一进程重复 `start()` 不注册两个 Timer。
- 水位之后无消息时不调用 Consolidator，Run 为 `completed` 且 candidateCount 为 0。
- 同一个频道、水位并发触发只产生一个有效 Run。
- 频道之间按独立维护队列运行，默认并发 1。
- 一个频道失败不阻止后续频道。
- 归档频道不进入 `enqueueAllActive`。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/dream-scheduler.test.ts server/application/dream-run-service.test.ts server/config.test.ts server/main.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现水位选择**

使用 `(created_at, id)` 复合水位，避免相同时间戳遗漏。输入快照在 Run 创建事务中固定；Dream 运行期间的新消息留给下一次 Run。

- [ ] **Step 4: 实现可停止 Scheduler 和维护队列**

下一次触发后才安排再下一次 Timer，避免 `setInterval` 的时区漂移。`main.ts` 在服务启动后 `start()`，关闭信号中 `stop()`；测试 App 默认不启动真实 Scheduler。

- [ ] **Step 5: 运行调度测试与 Build**

Run:

```bash
npm test -- server/application/dream-scheduler.test.ts server/application/dream-run-service.test.ts server/config.test.ts server/main.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/ports/clock.ts server/application/dream-scheduler.ts server/application/dream-scheduler.test.ts server/application/dream-run-service.ts server/application/dream-run-service.test.ts server/config.ts server/config.test.ts server/main.ts server/main.test.ts
git commit -m "feat: schedule incremental dream runs"
```

### Task 5: 实现人工审核、Memory 管理 API 与 SSE

**Files:**
- Create: `server/application/memory-review-service.ts`
- Create: `server/application/memory-review-service.test.ts`
- Modify: `server/domain/events.ts`
- Modify: `server/adapters/sse/sse-domain-event-publisher.ts`
- Modify: `server/adapters/sse/sse-domain-event-publisher.test.ts`
- Modify: `server/app.ts`
- Modify: `server/app.test.ts`

**APIs:**

```text
GET    /api/dream/runs
POST   /api/dream/runs
GET    /api/dream/runs/:runId
GET    /api/memory-candidates
POST   /api/memory-candidates/:candidateId/accept
POST   /api/memory-candidates/:candidateId/ignore
GET    /api/memories
PATCH  /api/memories/:memoryId
DELETE /api/memories/:memoryId
```

接受请求：

```ts
interface AcceptMemoryCandidateRequest {
  scope: 'global' | 'channel'
  channelId?: string
  content: string
}
```

- [ ] **Step 1: 写服务、鉴权边界和 API 失败测试**

覆盖：

- 只有 `pending` Candidate 可接受或忽略。
- Channel scope 必须指定存在的 Channel。
- 修改内容为空、超过 10,000 字或包含敏感模式时返回 400。
- 重复接受同一 Candidate 幂等返回原结果。
- PATCH 保留来源并更新 hash；与现有 Memory 冲突返回 409。
- DELETE 设置 `archivedAt`，来源行仍存在。
- API 不返回 Dream Runtime 原始日志和 Prompt。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- server/application/memory-review-service.test.ts server/app.test.ts server/adapters/sse/sse-domain-event-publisher.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现审核服务和 API**

`POST /api/dream/runs` 请求只接受：

```ts
{ channelId?: string }
```

有 `channelId` 时调用 `enqueue`，否则调用 `enqueueAllActive`。接口以 `202 Accepted` 立即返回已持久化的 Run 列表；执行通过维护队列继续，状态由 SSE 更新。

- [ ] **Step 4: 发布 Dream 与 Memory 事件**

```text
dream.run_created
dream.run_updated
memory.candidate_created
memory.candidate_reviewed
memory.changed
```

事件 payload 只含 ID、状态、scope、计数和时间，不含完整 Memory 内容。

- [ ] **Step 5: 运行 API、SSE 与 Build**

Run:

```bash
npm test -- server/application/memory-review-service.test.ts server/app.test.ts server/adapters/sse/sse-domain-event-publisher.test.ts
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/application/memory-review-service.ts server/application/memory-review-service.test.ts server/domain/events.ts server/adapters/sse/sse-domain-event-publisher.ts server/adapters/sse/sse-domain-event-publisher.test.ts server/app.ts server/app.test.ts
git commit -m "feat: add human memory review api"
```

### Task 6: 构建左侧 Dream 入口与审核中心

**Files:**
- Modify: `src/domain/workspace-view.ts`
- Modify: `src/api/client.ts`
- Modify: `src/api/use-workspace-events.ts`
- Modify: `src/api/use-workspace-events.test.tsx`
- Modify: `src/ui/RepositorySidebar.tsx`
- Modify: `src/ui/RepositorySidebar.test.tsx`
- Create: `src/ui/DreamCenter.tsx`
- Create: `src/ui/DreamCenter.test.tsx`
- Create: `src/ui/MemoryCandidateDetail.tsx`
- Create: `src/ui/MemoryCandidateDetail.test.tsx`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: 写 Dream Center 交互失败测试**

覆盖：

- 左侧固定 Dream 入口显示 pending 数量 badge。
- 点击进入独立 Dream Center，不改变当前频道的持久化选择。
- 四个 Tab：待确认、已接受、已忽略、已替代。
- 候选列表显示 scope、摘要、来源频道、来源数量和提取时间。
- 详情可以查看来源消息跳转、编辑内容和 scope、接受、忽略。
- “立即 Dream”可选择全部活跃频道或一个频道，并显示运行状态。
- 空状态、运行中、失败、无候选成功状态均有明确反馈。
- 移动端列表和详情不重叠。

- [ ] **Step 2: 运行前端测试并确认失败**

Run:

```bash
npm test -- src/ui/RepositorySidebar.test.tsx src/ui/DreamCenter.test.tsx src/ui/MemoryCandidateDetail.test.tsx src/ui/WorkspaceShell.test.tsx
```

Expected: FAIL。

- [ ] **Step 3: 扩展前端 API 和 SSE**

```ts
WorkspaceApi.listDreamRuns(): Promise<DreamRunView[]>
WorkspaceApi.startDream(channelId?: string): Promise<DreamRunView[]>
WorkspaceApi.listMemoryCandidates(status: MemoryCandidateStatus): Promise<MemoryCandidateView[]>
WorkspaceApi.acceptMemoryCandidate(id: string, input: AcceptMemoryCandidateRequest): Promise<MemoryView>
WorkspaceApi.ignoreMemoryCandidate(id: string): Promise<MemoryCandidateView>
WorkspaceApi.listMemories(): Promise<MemoryView[]>
WorkspaceApi.updateMemory(id: string, content: string): Promise<MemoryView>
WorkspaceApi.archiveMemory(id: string): Promise<MemoryView>
```

- [ ] **Step 4: 实现导航和审核工作流**

Dream Center 是主内容区视图，不塞入右侧 Context 卡片。待确认数量在 Bootstrap 中提供，SSE 后刷新。接受按钮提交期间禁用；成功后当前候选从待确认列表移除并进入已接受 Tab。

- [ ] **Step 5: 运行前端测试与 Build**

Run:

```bash
npm test -- src/api/use-workspace-events.test.tsx src/ui/RepositorySidebar.test.tsx src/ui/DreamCenter.test.tsx src/ui/MemoryCandidateDetail.test.tsx src/ui/WorkspaceShell.test.tsx
npm run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/domain/workspace-view.ts src/api/client.ts src/api/use-workspace-events.ts src/api/use-workspace-events.test.tsx src/ui/RepositorySidebar.tsx src/ui/RepositorySidebar.test.tsx src/ui/DreamCenter.tsx src/ui/DreamCenter.test.tsx src/ui/MemoryCandidateDetail.tsx src/ui/MemoryCandidateDetail.test.tsx src/ui/WorkspaceShell.tsx src/ui/WorkspaceShell.test.tsx src/styles.css
git commit -m "feat: add dream memory review center"
```

### Task 7: 安全、重启和端到端验收

**Files:**
- Create: `server/integration/dream-memory-flow.test.ts`
- Modify: `server/main.test.ts`
- Modify: `docs/raft-control-room-design.md`
- Modify: `specs/feature-tree.md`

- [ ] **Step 1: 写完整 Dream 流程集成测试**

测试：

1. 两个频道产生消息，手动 Dream 只处理指定频道。
2. Candidate 在人工确认前不进入任一 Agent Prompt。
3. 接受为 Global 后进入所有频道冷启动上下文。
4. 接受为 Channel 后只进入目标频道。
5. 修改和归档 Memory 后下次 Prompt 立即反映。
6. 重建应用后水位、待审核 Candidate、Memory 和 Thread Summary 均保留。
7. 相同水位重复运行不重复调用 Runtime 或创建 Candidate。
8. 敏感内容和 Runtime Artifact 不进入 Candidate。

- [ ] **Step 2: 运行集成测试并确认失败**

Run:

```bash
npm test -- server/integration/dream-memory-flow.test.ts server/main.test.ts
```

Expected: FAIL，直到全部依赖装配和恢复逻辑完成。

- [ ] **Step 3: 完成启动恢复与失败清理**

应用启动时：

- 将遗留 `running` Dream Run 标记为 `failed`，原因 `service_restarted`。
- 保留其水位但不推进成功水位；下次运行可重新处理同一输入。
- 清理不存在来源消息的非法 Candidate，记录审计错误，不物理删除其他有效记录。

- [ ] **Step 4: 更新架构文档和 Feature Tree**

记录 Dream 定时配置、维护队列、水位、Candidate 审核、Memory scope、Prompt 注入顺序和软归档语义。

- [ ] **Step 5: 运行完整自动化验证**

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

验证：

- 左侧 Dream badge 和入口。
- 手动运行单频道与全部频道。
- 无新消息时快速成功且无候选。
- 来源查看、编辑 scope/content、接受、忽略。
- 接受后的 Memory 在下一次 Agent 冷启动上下文生效。
- 刷新和服务重启后状态保持。
- 桌面与窄屏无重叠，控制台无错误。

- [ ] **Step 7: Commit**

```bash
git add server/integration/dream-memory-flow.test.ts server/main.test.ts docs/raft-control-room-design.md specs/feature-tree.md
git commit -m "test: verify dream memory lifecycle"
```

## Completion Gate

- [ ] 多 Agent 对话回合计划已经完整通过。
- [ ] 所有七个任务各自有通过的聚焦测试和独立 Commit。
- [ ] `npm test -- --run` 与 `npm run build` 通过。
- [ ] Candidate 未确认前绝不进入 Prompt。
- [ ] 来源可追溯，Memory 删除为软归档。
- [ ] 自动 Dream、手动 Dream、no-op、失败隔离、重启恢复和幂等均通过。
- [ ] 浏览器完成 Dream Center 桌面与窄屏验收。
