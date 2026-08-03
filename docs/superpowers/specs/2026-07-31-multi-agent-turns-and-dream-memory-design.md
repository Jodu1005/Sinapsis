# 多 Agent 回合与 Dream Memory 设计

## 状态

已确认，日期为 2026-07-31。

## 目标

在现有 Channel、Thread、全局 Agent、Workspace 和 Runtime Adapter 之上，增加一套受控的多 Agent 对话机制：

- 普通消息使用职责标签预筛，再由候选 Agent 自主判断是否参与。
- `@Agent` 精确路由到指定频道成员。
- `@all` 让当前频道的全部可用 Agent 并行正式回答。
- Agent 可以在受控回合中通过结构化 handoff 把下一棒交给其他频道成员。
- 同一个 Thread 中的 Agent 共享公开消息上下文，但保持各自独立的 Runtime Session。
- 通过 Global Memory、Channel Memory 和 Thread Summary 支持 Session 冷启动。
- 每晚运行 Dream 提取候选记忆，所有候选必须由人类确认后才能进入 Agent Prompt。
- 左侧导航增加 Dream 中心，集中审核、编辑和追溯候选记忆。

该设计借鉴 Clowder 的 Thread 隔离、显式路由、独立队列、Worklist、A2A handoff 和防乒乓机制，但不照搬其默认 Agent 回退逻辑。Sinapsis 保留职责驱动的发布订阅体验，并由确定性 Coordinator 控制成本和发言顺序。

## 非目标

本期不实现：

- 所有频道 Agent 对每条普通消息都调用 LLM。
- Agent 自动写入已生效的长期 Memory。
- Agent 共享一个底层 Runtime Session。
- `@all` 回答触发新的自动 handoff。
- Agent 私有推理、原始 JSONL、stdout 或 stderr 进入公开上下文或 Memory。
- 跨用户远程权限系统。
- Agent 自主修改频道成员、删除 Workspace 或删除 Memory。

## 当前行为与迁移目标

当前 `ConversationCoordinator` 已经按照以下键维护对话执行：

```text
agentId + channelId + threadRootMessageId
```

同一个 Agent 在同一个 Channel/Thread 中完成回复后，运行中的 Sinapsis 服务会保留 Runtime Session。下一条消息通过 `sendInput` 继续同一个 Session。OpenCode 和 Claude Code 可以使用 `sessionId` 恢复后续进程，Pi 可以使用 Runtime Session 文件或 RPC 状态继续对话。

最近八条消息只用于首次创建 Session 的初始上下文，不是每轮对话的固定上限。

当前限制是 Conversation Session 映射只存在于服务内存中。服务重启、Runtime 失败、频道上下文重置或 Agent 移除后，Session 无法由应用层恢复；下一条消息只能使用最近八条消息冷启动。

目标行为：

```text
正常路径：复用或恢复 Agent 独立 Runtime Session
冷启动：Global Memory + Channel Memory + Thread Summary + 最近消息
```

Runtime Session 仍受具体模型的上下文窗口和压缩能力限制，不能视为无限历史。持久化 Memory 和 Summary 是可恢复的系统事实来源。

## 核心术语

### ConversationTurn

一条人类消息触发的完整协作链。它覆盖职责预筛、参与判断、正式回复、重复检查和可选 handoff，直到满足停止条件。

### TurnParticipant

一次 ConversationTurn 中某个候选 Agent 的参与记录，包含预筛分数、结构化决策、置信度、发言角度、顺序和跳过原因。

### AgentInvocation

一次具体 Runtime 调用。调用类型包括：

- `participation_probe`
- `response`
- `duplicate_check`
- `handoff_response`
- `parallel_response`

### Handoff

一个 Agent 完成公开发言后，把明确问题交给另一个频道成员。界面显示自然语言 `@Agent`，后端只依据经过验证的结构化 `handoffTo` 路由。

### MemoryCandidate

Dream 从公开消息中提取、尚未生效的候选记忆。未经人类接受，不会进入任何 Agent Prompt。

## 总体架构

```text
Human Message
  -> Channel Message 持久化
  -> ChannelTurnCoordinator
  -> ResponsibilityMatcher
  -> ParticipationProbe
  -> AgentInvocationQueue
  -> Runtime Adapter
  -> Agent Reply 持久化
  -> HandoffPolicy
  -> Turn 完成
  -> Nightly Dream
  -> MemoryCandidate
  -> Human Review
  -> Active Memory
```

### ResponsibilityMatcher

无副作用的本地匹配器，不调用 LLM。输入为人类消息和当前频道成员，输出按相关性排序的候选列表。

匹配信息来自：

- `Agent.capabilityTags`
- `Agent.responsibilities`
- 集中维护的能力标签别名
- 英文关键词
- 中文双字组合

默认最多返回三个候选，配置上限为五个。普通消息只对候选执行 ParticipationProbe。

建议的基础计分：

```text
完整职责短语命中       +12
能力标签精确命中       +10
标签别名命中           +8
中文双字组合命中       每个 +3
英文关键词命中         每个 +2
general / 通用回复      +1
```

不属于频道、Runtime 离线或处于错误状态的 Agent 直接排除。忙碌 Agent 可以成为候选，但进入独立队列，不阻塞其他 Agent。

能力别名必须放在集中配置中，不散落在 Coordinator：

```ts
{
  frontend: ['前端', '界面', 'ui', 'react', 'css'],
  backend: ['后端', 'api', '数据库', 'schema'],
  test: ['测试', 'test', 'vitest', '验证'],
  review: ['审查', 'review', '代码检查']
}
```

### ParticipationProbe

最多三个候选并行进行轻量判断。Runtime 返回严格结构：

```json
{
  "decision": "speak",
  "confidence": 0.88,
  "reason": "问题涉及 React 界面状态",
  "proposedAngle": "检查错误状态渲染",
  "dependsOnAgentId": null
}
```

`decision` 只能是：

- `speak`: 希望正式发言。
- `silent`: 不需要参与。

结构解析失败、超时或目标越权时，该 Probe 标记为失败，不影响其他候选。

ParticipationProbe 不允许在尚未公开发言时创建 handoff。Handoff 只能来自已经落库的正式 Agent 回复。

### ChannelTurnCoordinator

Coordinator 使用确定性规则调度，不额外调用一个总指挥 LLM。

排序采用词典式优先级，而不是难以解释的综合魔法分：

1. 人类直接提及。
2. 有效的结构化 handoff。
3. `dependsOnAgentId` 形成的依赖顺序。
4. ResponsibilityMatcher 分数。
5. ParticipationProbe 置信度。
6. Agent 队列可用性。
7. 最近较少发言者优先。
8. Agent ID 作为稳定最终顺序。

普通消息最多批准两名首轮发言者。第二名发言前必须读取第一名已经落库的公开回复，并执行一次 `duplicate_check`：

```json
{
  "decision": "speak",
  "reason": "仍需补充测试覆盖",
  "revisedAngle": "补充失败路径测试"
}
```

如果已有回复覆盖相同观点，返回 `silent` 并结束该参与记录。

### AgentInvocationQueue

每个 Agent 有独立调用队列和一个并发槽。不同 Agent 可以并行，同一个 Agent 的调用顺序可预测。

队列优先级：

1. 人类直接 `@Agent`。
2. `@all` 或多目标明确点名。
3. 普通 Turn 中已批准的正式回复。
4. ParticipationProbe 和 duplicate check。
5. 自动 handoff。
6. Dream Memory 整理。

新的人类消息可以排在尚未开始的自动 handoff 前面，但不强行中断已经开始生成的公开回复。

队列记录持久化。服务重启时，已开始但未完成的 Invocation 标记为 `interrupted`；系统不会自动重复发送公开回复。尚未开始的调用是否恢复，由 Invocation 类型和幂等键决定。

### HandoffPolicy

Handoff 只在普通受控 Turn 和单个 `@Agent` 路径中启用。

规则：

- 当前 Agent 可以先公开发言，再提出 handoff。
- 每条回复最多提出两个目标。
- 目标必须是当前频道成员。
- 目标 Agent 可以接受或拒绝。
- 同一个 Agent 在一条协作链中不能重复进入。
- 检测并阻止 `A -> B -> A`。
- 整条协作链最多三轮。
- handoff 必须包含明确问题。
- 人类消息优先于尚未开始的自动 handoff。

Agent 的自然语言回复可以展示：

```text
@前端 Agent 请确认这个接口变化对表单交互的影响。
```

后端只依据结构化输出路由：

```json
{
  "response": "接口需要增加幂等校验。",
  "handoffTo": [
    {
      "agentId": "agent-frontend",
      "question": "请确认这个变化对表单交互的影响"
    }
  ]
}
```

普通文字中偶然出现 Agent 名称不会触发 handoff。

## 三种消息模式

### 普通消息

```text
消息落库
-> 创建 ConversationTurn
-> 本地预筛最多三个候选
-> 候选并行 ParticipationProbe
-> Coordinator 批准最多两人
-> 第一位正式回复并落库
-> 第二位读取最新上下文并做重复检查
-> 可选 handoff
-> 最多三轮
-> Turn 完成或部分完成
```

如果没有候选愿意发言，选择当前频道带 `general` 或 `通用回复` 能力的可用 Agent 兜底。频道没有可用兜底 Agent 时，Turn 正常结束并显示“没有合适的 Agent 参与”，不伪造 Agent 回复。

### 单个 `@Agent`

单个精确提及跳过职责预筛和 ParticipationProbe。目标必须是当前频道成员；`summit` 根据自动全员策略解析成员。

目标 Agent 进入自己的队列并正式回答。该路径允许结构化 handoff，仍受三轮、去重和防乒乓限制。

忙碌 Agent 不丢弃消息，而是创建 queued Invocation，并在界面显示排队状态。

### 多个 `@Agent`

人类明确点名多个 Agent 时，只对这些目标执行并行正式回答。行为与 `@all` 一致，但目标集合更小。该模式禁止自动 handoff。

### `@all`

`@all` 跳过职责预筛和 ParticipationProbe，面向当前频道全部成员。

- 空闲 Agent 立即并行生成正式回答。
- 忙碌 Agent 进入自己的队列。
- 离线或错误 Agent 记录为不可用，不阻塞其他回答。
- 所有有效回答独立写入 Channel/Thread。
- 单个失败不影响其他 Agent。
- 不限制为两个发言者。
- 禁止自动 handoff，防止调用指数增长。

Agent 可以在文字中建议继续咨询谁，但不会创建新的自动回合。

## Turn 状态机

```text
received
-> screening
-> probing
-> responding
-> handoff
-> completed
```

终态：

- `completed`: 调度正常结束。
- `partial`: 已有有效回复，但部分调用失败或超时。
- `failed`: 没有任何有效回复且出现系统级错误。
- `cancelled`: 人工取消、频道归档、上下文重置或成员边界变化。
- `interrupted`: 服务重启导致运行中状态失效。

AgentInvocation 状态：

```text
queued -> preparing -> running -> completed
                              -> failed
                              -> timed_out
queued -> cancelled
running -> interrupted
```

## Session 与上下文

### Runtime Session

Session 粒度保持：

```text
agentId + channelId + threadRootMessageId
```

不同 Agent 不共享底层 Session。不同 Channel 和不同 Thread 也不共享 Session。

新增持久化 ConversationSession 记录：

```text
agent_id
channel_id
thread_root_message_id
runtime
runtime_session_id
runtime_session_file
status
last_used_at
```

服务重启后先尝试通过 Runtime Adapter 恢复 Session。恢复失败时标记原记录为 `stale`，然后使用持久化 Memory、Summary 和最近消息冷启动。

### Prompt 组装顺序

```text
系统和只读安全规则
-> Agent 身份、职责和能力标签
-> 已确认的 Global Memory
-> 当前 Channel Memory
-> 当前 Thread Summary
-> 最近 Thread 原始消息
-> 本轮已公开的 Agent 回复
-> 当前用户消息
-> Participation / Response / Duplicate Check 指令
```

公开消息是多 Agent 共享事实来源。Agent 私有 Runtime Session 不是其他 Agent 的上下文来源。

## Memory 分层

### Global Memory

控制室级别的稳定偏好和规范，注入所有 Agent Prompt，例如：

- 人类长期偏好。
- 文档语言和输出规范。
- 所有项目通用的安全约束。

Global Memory 不保存某个 Channel 的原始聊天。

### Channel Memory

仅当前 Channel 成员可用：

- 项目决策。
- 频道目标和约束。
- 已确认术语。
- 稳定工作规范。
- 需要长期跟踪的问题。

每条 Memory 必须保留来源消息 ID。

### Thread Summary

Thread 的工作记忆：

- 当前讨论目标。
- 已提出观点。
- 已确认结论。
- 未解决问题。
- handoff 路径。

Thread Summary 可以由系统更新，但它不是已确认长期 Memory。它只用于恢复当前 Thread 上下文。

## Dream Memory

### 定时任务

默认每天本地时间 03:00 运行，时区可配置。没有新活动的 Channel 不调用 LLM。

```text
读取上次 watermark 后的公开消息和已完成 Turn
-> 规则过滤低价值内容
-> 按 Channel/Thread 分块
-> MemoryConsolidator 提取结构化候选
-> 与现有 Memory 和待确认候选去重
-> 检测冲突和替代关系
-> 写入 MemoryCandidate
-> 更新 watermark
```

Dream 只读取：

- 已投递的人类消息。
- 已公开的 Agent 回复。
- 已完成 Turn 的结构化结果。
- 人工确认和任务验收产生的公开结论。

Dream 不读取：

- Agent 私有推理。
- Runtime 原始日志。
- stdout、stderr 或 JSONL。
- 密钥、Token 和已标记敏感内容。

### 提取规则

候选类型：

- `decision`
- `preference`
- `constraint`
- `fact`
- `working_rule`
- `open_question`

候选示例：

```json
{
  "scope": "channel",
  "scopeId": "channel-summit",
  "kind": "decision",
  "content": "普通消息按职责预筛，最多保留三个候选 Agent。",
  "sourceMessageIds": ["msg-123", "msg-128"],
  "confidence": 0.96,
  "importance": 0.91
}
```

以下内容不生成候选：

- 临时运行状态。
- 寒暄。
- 未确认猜测。
- 重复内容。
- 很快过期的任务进度。
- 敏感信息。

### 人工确认

所有 MemoryCandidate 都必须人工确认。无论 Global 还是 Channel 候选，未经确认都不会进入 Prompt。

人工操作：

- 接受。
- 编辑内容或作用域后接受。
- 忽略。
- 查看来源消息。
- 将旧 Memory 标记为被新 Memory 替代。

MemoryCandidate 状态：

```text
pending -> accepted
        -> ignored
        -> superseded
```

已接受 Memory 状态：

```text
active -> superseded
       -> archived
```

夜间没有候选时，DreamRun 正常完成，不创建空的候选记录。

### 手动 Dream

左侧 Dream 入口进入 Dream 中心，不直接开始执行。

Dream 中心提供“立即整理”，人类可以选择：

- 所有有新增内容的频道。
- 指定频道。

手动运行与夜间任务共用幂等键、watermark、提取和人工确认流程。

## Dream 中心界面

左侧边栏在频道列表和 Agent 状态之间提供固定 Dream 入口，并显示待确认数量。

Dream 中心包含：

- 下次自动运行时间和时区。
- “立即整理”入口。
- `待确认`、`已接受`、`已忽略`、`已替代` 四个视图。
- 候选列表，展示作用域、类型、置信度和来源数量。
- 详情区，可编辑内容和作用域。
- 来源消息跳转。
- 接受、编辑后接受和忽略操作。
- DreamRun 的扫描、提取、去重、完成和失败状态。

候选和内部 Memory JSON 不写入 Channel 时间线。

## Channel 界面反馈

频道时间线只展示对人类有用的实时状态：

- “正在筛选合适的 Agent”
- “newton 正在判断是否参与”
- “前端 Agent 正在准备回复”
- “clawd 正在等待当前 Agent 回复”

最终只展示自然的 Agent 回复和可见 handoff。内部 Participation JSON、排序分数和 Runtime 日志不进入频道。

右侧 Turn 详情按需展示：

- 候选 Agent 和匹配原因。
- Participation 决策。
- 调度顺序。
- 当前轮次。
- 跳过、重复、超时和失败原因。
- handoff 路径。

## 持久化模型

新增或扩展：

```text
conversation_turns
  id
  channel_id
  thread_root_message_id
  trigger_message_id
  mode
  status
  current_round
  max_rounds
  created_at
  updated_at
  completed_at

turn_participants
  id
  turn_id
  agent_id
  matcher_score
  decision
  confidence
  proposed_angle
  depends_on_agent_id
  speaking_order
  status
  reason

agent_invocations
  id
  turn_id
  agent_id
  kind
  priority
  round
  status
  idempotency_key
  source_invocation_id
  queued_at
  started_at
  completed_at
  error_code

conversation_handoffs
  id
  turn_id
  source_invocation_id
  from_agent_id
  to_agent_id
  question
  round
  status
  created_at

conversation_sessions
  id
  agent_id
  channel_id
  thread_root_message_id
  runtime
  runtime_session_id
  runtime_session_file
  status
  last_used_at

thread_summaries
  thread_root_message_id
  channel_id
  content
  source_message_watermark
  updated_at

dream_runs
  id
  scope
  scope_id
  status
  watermark_from
  watermark_to
  started_at
  completed_at
  error_code

memory_candidates
  id
  dream_run_id
  scope
  scope_id
  kind
  content
  confidence
  importance
  status
  created_at
  reviewed_at

memory_candidate_sources
  candidate_id
  message_id

memories
  id
  scope
  scope_id
  kind
  content
  status
  source_candidate_id
  created_at
  updated_at

memory_sources
  memory_id
  message_id
```

约束：

- 一个触发消息最多对应一个 ConversationTurn。
- ConversationSession 按 Agent、Channel、Thread 唯一。
- Invocation 幂等键唯一。
- handoff 目标必须属于 Turn 的 Channel。
- Memory 来源消息必须属于对应作用域。
- `accepted` Candidate 必须对应一个 Memory。

## 服务边界

### ResponsibilityMatcher

纯函数，负责本地职责评分和候选上限。

### ParticipationService

负责构建 Participation Prompt、解析结构化结果和超时处理。

### ChannelTurnCoordinator

负责三种消息模式、排序、轮次、重复检查和终态。

### AgentInvocationQueue

负责每 Agent 队列、优先级、并发槽、幂等和恢复。

### ConversationSessionService

负责 Session 键、Runtime Session 元数据持久化、恢复和冷启动。

### ContextAssembler

负责按固定顺序组装 Global Memory、Channel Memory、Thread Summary 和近期消息。

### HandoffPolicy

纯函数，负责目标验证、轮数、去重和防乒乓。

### DreamScheduler

负责定时触发、时区、watermark、重试和幂等。

### MemoryConsolidator

负责从公开对话中提取候选，不直接写入 Active Memory。Dream 使用独立的维护队列和可配置 Runtime Profile，不占用频道 Agent 的对话队列或并发槽。

### MemoryReviewService

只接受人类控制面的接受、编辑、忽略、替代和归档操作。

## API

现有消息 API 继续作为入口，服务端解析模式：

```text
POST /api/channels/:channelId/messages
```

新增：

```text
GET  /api/channels/:channelId/turns/:turnId
POST /api/channels/:channelId/turns/:turnId/cancel

GET  /api/dream/runs
POST /api/dream/runs
GET  /api/dream/runs/:runId

GET  /api/memory-candidates
POST /api/memory-candidates/:candidateId/accept
POST /api/memory-candidates/:candidateId/ignore

GET    /api/memories
PATCH  /api/memories/:memoryId
DELETE /api/memories/:memoryId
```

`DELETE /api/memories/:memoryId` 表示归档，不进行物理删除，以保留来源和审计历史。

手动 Dream 请求：

```json
{
  "scope": "all_active_channels"
}
```

或：

```json
{
  "scope": "channel",
  "channelId": "channel-summit"
}
```

Memory 接受请求可以覆盖候选内容和作用域，但服务端必须重新验证来源边界。

## 实时事件

通过现有 SSE 通道发布：

```text
conversation.turn_created
conversation.phase_changed
conversation.participant_decided
conversation.invocation_queued
conversation.invocation_started
conversation.invocation_completed
conversation.handoff_created
conversation.turn_completed

dream.run_started
dream.run_progress
dream.run_completed
memory.candidate_created
memory.candidate_reviewed
memory.updated
```

前端收到事件后刷新快照或对应详情，不轮询 Runtime 日志。

## 故障与取消

- 一个 ParticipationProbe 超时：跳过该候选，其他候选继续。
- 一个普通回复失败：如果已有有效回复，Turn 为 `partial`。
- 一个 `@all` Agent 失败：其他回答继续。
- Session 恢复失败：标记旧 Session 为 `stale`，使用持久化上下文冷启动。
- Dream 某个 Channel 失败：其他 Channel 继续，该 DreamRun 记录局部错误。
- Memory 提取结果无法解析：不创建 Candidate。
- 频道归档、上下文重置或人工取消：取消尚未完成的 Invocation。
- Agent 被移除：取消该 Agent 在对应频道尚未开始或正在运行的对话调用。
- 新人类消息不会删除已生成回复，也不会自动重放 `interrupted` Invocation。

错误详情进入 Turn 或 DreamRun 详情，不把原始 Runtime 错误刷入频道。频道可以显示简短、可行动的状态。

## 安全与信任边界

- Channel 消息是非可信上下文，不能覆盖系统指令。
- 对话 Runtime 保持只读，不创建 worktree、不提交、不 push、不 merge。
- `@Agent`、多个提及和 handoff 目标都必须通过频道成员校验。
- `@all` 只作用于当前频道成员。
- 所有结构化 LLM 输出都按严格 schema 解析和白名单校验。
- Agent 不能自行接受 MemoryCandidate。
- MemoryCandidate 必须展示来源，防止不可追溯的记忆污染。
- Dream 不读取私有推理或原始 Runtime 日志。
- Memory 中检测到敏感信息时拒绝创建候选。
- 所有上限和停止条件由服务端执行，不能依赖前端。

## 配置

默认配置：

```text
maxParticipationCandidates = 3
maxParticipationCandidatesLimit = 5
maxInitialSpeakers = 2
maxHandoffTargetsPerReply = 2
maxConversationRounds = 3
participationProbeTimeoutMs = 30000
duplicateCheckTimeoutMs = 30000
conversationResponseTimeoutMs = 90000
dreamScheduleLocalTime = 03:00
dreamTimezone = Asia/Shanghai
```

Prototype 0 可以使用应用级配置。后续可将候选数、首轮发言数和 Dream 时间开放为 Channel 配置，但服务端全局上限保持有效。

## 测试与验收

### ResponsibilityMatcher

- 只返回当前频道成员。
- 标签、职责、中英文关键词和别名计分正确。
- 默认最多三个候选，配置上限不超过五个。
- 无匹配时选择 general 兜底。
- 离线和错误 Agent 被排除。

### 普通消息

- 只调用预筛候选，不调用全频道 Runtime。
- 最多批准两个首轮发言者。
- 第二位能读取第一位公开回复。
- 重复观点会返回 silent，不创建重复公开消息。
- 单个 Probe 或回复失败不会阻塞其他 Agent。

### 提及路由

- 单个 `@Agent` 精确路由并允许 handoff。
- 非成员不能通过提及绕过频道边界。
- 多个显式提及并行回答且不触发自动 handoff。
- `@all` 对全部频道成员并行回答。
- `@all` 单个失败不影响其他回答。
- `@all` 输出中的结构化 handoff 被忽略并记录原因。

### Handoff

- 有效 handoff 在回复落库后进入下一轮。
- 目标拒绝时正常结束。
- 超过两个目标被拒绝。
- 超过三轮停止。
- 同 Agent 重复进入停止。
- `A -> B -> A` 被阻止。
- 新人类消息优先于未开始的自动 handoff。

### Session 与上下文

- 同一 Agent、Channel、Thread 复用 Session。
- 不同 Agent、Channel 或 Thread 使用不同 Session。
- 服务重启后可以恢复持久化 Session 元数据。
- Runtime 恢复失败时使用 Memory、Summary 和最近消息冷启动。
- Prompt 不包含其他 Channel Memory。
- Agent B 能通过公开 Thread 消息看到 Agent A 的回复，但不能访问 A 的私有 Session。

### Dream 与 Memory

- 无新增活动时不调用 MemoryConsolidator。
- 只处理 watermark 后的公开消息。
- 重复运行不重复创建 Candidate。
- 无有效记忆时正常完成且不创建 Candidate。
- Candidate 未确认时不进入 Prompt。
- 接受、编辑后接受、忽略和替代流程正确。
- 来源消息可以追溯。
- 敏感内容不会生成 Candidate。
- Global 和 Channel Memory 不跨作用域泄漏。

### 界面

- 左侧 Dream 入口显示待确认数量。
- Dream 中心可以立即整理全部或指定 Channel。
- 候选列表、详情、来源和人工操作完整。
- Channel 显示筛选、判断、准备、排队和 handoff 状态。
- 内部 JSON 和 Runtime 原始日志不进入时间线。
- Turn 详情可以查看候选、顺序、轮次、跳过和失败原因。

## 迁移

实现采用增量迁移：

1. 新增 Turn、Participant、Invocation、Handoff 和 ConversationSession 表。
2. 保留现有 Message、Channel、Thread 和 Agent 数据。
3. 将现有内存 Session 管理接入 ConversationSessionService。
4. 将现有 `responsibilityScore` 提取为 ResponsibilityMatcher，并保持旧行为兼容测试。
5. 新增 Thread Summary、DreamRun、MemoryCandidate 和 Memory 表。
6. 默认关闭多 Agent 普通消息调度，通过配置或迁移完成后启用。
7. 启用后保留单个 `@Agent` 的兼容路径，再逐步切换普通消息和 `@all`。

迁移不删除已有消息、任务、Session 文件、worktree、证据或产物。

## Feature Tree

```text
多 Agent 对话
├── 普通消息
│   ├── 职责预筛
│   ├── 参与判断
│   ├── 确定性排序
│   ├── 最多两名首轮发言者
│   └── 第二位重复检查
├── 提及
│   ├── 单个 @Agent
│   ├── 多个 @Agent 并行
│   └── @all 全员并行
├── Handoff
│   ├── 结构化目标
│   ├── 接受或拒绝
│   ├── 最多三轮
│   └── 去重与防乒乓
├── Session
│   ├── Agent + Channel + Thread 隔离
│   ├── 元数据持久化
│   └── 恢复失败冷启动
├── Memory
│   ├── Global Memory
│   ├── Channel Memory
│   └── Thread Summary
└── Dream
    ├── 每晚增量提取
    ├── 手动立即整理
    ├── 候选去重和冲突
    ├── 人工确认
    └── Dream 中心
```
