# Task 2 Report: Confirmed Memory Context

## 实现内容

- 新增 migration 21，为 `thread_summaries` 增加 `through_message_created_at` 与 `through_message_id`，并补齐 Thread Summary 的读取和事务化 upsert 仓储 API；升级测试确认旧 Summary 内容原样保留且水位初始为 `NULL`。
- 新增 `ThreadSummaryService`，只处理 Thread 的公开消息并增量保存水位。仓储通过持久化消息行的 `created_at,rowid` 查询水位后的消息，即使水位已软删除也不会退回字典序猜测。生成或写入失败返回旧 Summary，不阻断当前 Turn。
- 扩展 `ContextAssembler`，按 Global Memory、Channel Memory、Thread Summary、近期公开消息的固定边界渲染；Timeline 不读取 Thread Summary，当前消息、已删除消息、非公开消息、非 accepted Candidate、归档 Memory 和其他 Channel Memory 均不会进入上下文。
- Global 与 Channel Memory 先合并排序和选择，再按原 scope 分区渲染。排序按 `updatedAt` 降序，同一更新时间按来源 `confidence * importance` 降序，最后以 ID 稳定排序。
- `tokenBudget` 在本任务中定义为字符预算。Memory、Summary 和近期消息的每次保留判断都使用最终渲染长度，包含标题、JSON 数据和分区间隔；预算低于最小骨架时返回空字符串，测试覆盖 0、1 和骨架边界。
- Participation、duplicate check、response 与 handoff response 通过同一个 bounded context，并各自追加独立的“当前调用指令”边界。Participation 的协议 prompt 只引用独立 context，不再重复嵌入历史。
- 保持 Runtime Session 增量语义：四类调用都发送“协议与输出约束 + 当前增量”的安全 JSON envelope，不重发完整历史；duplicate 只额外携带当前 Turn 已持久化公开回复。冷启动或恢复失败时才通过 description/context 提供完整 bounded context。
- Thread Summary refresh 从 Turn critical path 解耦：Thread Turn 启动后台刷新并吞掉同步或异步失败，本 Turn 使用旧 Summary 加水位后消息，下一 Turn 使用新 Summary；悬挂刷新不会阻塞完成、取消或 claim 释放。
- production `createApp` 默认装配 `DeterministicRollingThreadSummaryGenerator`，通过 `ConversationCoordinator` 注入 `ChannelTurnCoordinator`；结果确定且硬限制为 4000 字符。

## RED / GREEN

- Coordinator 初始 RED：旧 context 缺少“系统与 Agent 职责”和“当前调用指令”边界；duplicate 旧断言仍从 `initialMessage` 读取历史；Participation 历史被 prompt 与 bounded context 重复拼接。
- 水位 RED：同毫秒消息按仓储 `created_at, rowid` 排序，但旧增量过滤按 `createdAt + id`，逆字典序 ID 会重复或遗漏消息。
- Memory RED：Global budget 先消耗会淘汰更新的 Channel Memory；同更新时间未按来源质量稳定决胜；预算未完整覆盖标题和项目符号。
- GREEN 专项：`npm test -- --run server/adapters/sqlite/sqlite-repositories.test.ts server/application/context-assembler.test.ts server/application/thread-summary-service.test.ts server/application/channel-turn-coordinator.test.ts server/application/conversation-session-service.test.ts`，5 个文件、132/132 通过。
- Fix round 1 RED：仓储 Summary 可被乱序 refresh 回退；删除水位 fallback 会漏同毫秒逆序 ID；warm/resume 丢失调用协议；refresh 挂起阻塞 Turn；历史文本可形成同级指令标题；production 未装配 generator；极小预算超界；水位双列可被直接 SQL 拆开。
- Fix round 1 GREEN：专项 6 个文件、148/148 通过。
- Fix round 2 RED：migration 21 既存半水位在 trigger 创建后仍残留；同一 Thread 并发 refresh 重复调用 generator；悬挂 generator 无 timeout/cancel signal，且 Coordinator 取消不传播 maintenance abort。
- Fix round 2 GREEN：SQLite/Thread Summary/Coordinator 专项 3 个文件、113/113 通过。
- GREEN 全量：`npm test -- --run`，52 个文件、489/489 通过。
- Build：`npm run build` 通过，包括 `tsc --noEmit` 与 Vite production build。
- Diff check：`git diff --check` 通过。

## 增量与边界

- Summary upsert 在 `BEGIN IMMEDIATE` 事务中按同 Thread 消息的 `created_at,rowid` 比较水位；旧水位或相同水位不会覆盖当前 Summary。测试覆盖双 refresh 乱序完成。
- migration 22 在创建 INSERT/UPDATE trigger 前，将既存“仅一个水位列为 NULL”的行保守修复为双 `NULL`；随后约束两个水位列同时为 `NULL` 或同时非空。测试覆盖 migration 21 半水位升级和直接 SQL 失败，migration 21 保持不变。
- 每层历史以单行 safe JSON 编码，`<`、`>`、`&` 转为 Unicode escape；Memory、Summary 和 message 中的闭合标记或“当前调用指令”只能留在 JSON string 内。
- Summary 刷新入口已由 production composition root 默认装配并覆盖 next-Turn 可见、失败不阻断、悬挂不阻塞与 Timeline 不调用。
- `ThreadSummaryService` 按 channel+thread single-flight；generator 接收 `AbortSignal`。维护默认 5 秒超时且测试可注入短 timeout，超时或显式 cancel 会 abort 并在 `finally` 清理 in-flight，允许后续 refresh 重试。
- Coordinator 取消 Thread Turn 时调用可选 Summary cancel，但不等待维护结束；Timeline 或未提供 cancel 的实现不受影响。
- Summary 刷新失败时，ContextAssembler 会继续使用旧 Summary 及水位后的公开消息，保持当前对话可用。

## 改动文件

- `server/domain/memory.ts`
- `server/ports/repositories.ts`
- `server/adapters/sqlite/schema.ts`
- `server/adapters/sqlite/sqlite-repositories.ts`
- `server/adapters/sqlite/sqlite-repositories.test.ts`
- `server/application/context-assembler.ts`
- `server/application/context-assembler.test.ts`
- `server/application/safe-json.ts`
- `server/application/thread-summary-service.ts`
- `server/application/thread-summary-service.test.ts`
- `server/application/channel-turn-coordinator.ts`
- `server/application/channel-turn-coordinator.test.ts`
- `server/application/conversation-session-service.test.ts`
- `server/application/conversation-coordinator.ts`
- `server/integration/multi-agent-conversation-flow.test.ts`
- `server/app.ts`

## 残余风险

- `tokenBudget` 沿用既有参数名，但实现按需求简报使用字符数而非模型 tokenizer 计数；后续若切换为真实 token 预算，需要统一替换成本函数和相应测试。
- 默认 rolling generator 是确定性的有界文本滚动器，不做模型级语义压缩；接口仍保留为可替换依赖，后续可接 Runtime-backed summarizer。
- Service 会在 timeout/cancel 后停止等待并发出 abort；替换 generator 若要立即释放自身外部资源，仍需正确响应传入的 `AbortSignal`。
