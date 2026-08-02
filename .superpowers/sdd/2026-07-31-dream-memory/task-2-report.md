# Task 2 Report: Confirmed Memory Context

## 实现内容

- 新增 migration 21，为 `thread_summaries` 增加 `through_message_created_at` 与 `through_message_id`，并补齐 Thread Summary 的读取和事务化 upsert 仓储 API；升级测试确认旧 Summary 内容原样保留且水位初始为 `NULL`。
- 新增 `ThreadSummaryService`，只处理 Thread 的公开消息并增量保存水位。水位消息仍可见时按仓储稳定会话顺序定位并截取后续消息；水位被删除时才回退到 `createdAt + id` 边界。生成或写入失败返回旧 Summary，不阻断当前 Turn。
- 扩展 `ContextAssembler`，按 Global Memory、Channel Memory、Thread Summary、近期公开消息的固定边界渲染；Timeline 不读取 Thread Summary，当前消息、已删除消息、非公开消息、非 accepted Candidate、归档 Memory 和其他 Channel Memory 均不会进入上下文。
- Global 与 Channel Memory 先合并排序和选择，再按原 scope 分区渲染。排序按 `updatedAt` 降序，同一更新时间按来源 `confidence * importance` 降序，最后以 ID 稳定排序。
- `tokenBudget` 在本任务中定义为字符预算。Memory、Summary 和近期消息的每次保留判断都使用最终渲染长度，包含标题、项目符号、换行和分区间隔；测试覆盖渲染结果不超过传入预算。固定的“近期公开消息”分区是最小上下文骨架。
- Participation、duplicate check、response 与 handoff response 通过同一个 bounded context，并各自追加独立的“当前调用指令”边界。Participation 的协议 prompt 只引用独立 context，不再重复嵌入历史。
- 保持 Runtime Session 增量语义：可恢复 Session 只发送当前 `initialMessage`，不重发历史；冷启动或恢复失败时才通过 description/context 提供完整上下文。
- Coordinator 支持可选注入 `ThreadSummaryService.refresh`：Thread Turn 开始时刷新一次并捕获失败，Timeline 不调用。刷新成功后本 Turn 读取新 Summary，刷新失败仍继续回答。

## RED / GREEN

- Coordinator 初始 RED：旧 context 缺少“系统与 Agent 职责”和“当前调用指令”边界；duplicate 旧断言仍从 `initialMessage` 读取历史；Participation 历史被 prompt 与 bounded context 重复拼接。
- 水位 RED：同毫秒消息按仓储 `created_at, rowid` 排序，但旧增量过滤按 `createdAt + id`，逆字典序 ID 会重复或遗漏消息。
- Memory RED：Global budget 先消耗会淘汰更新的 Channel Memory；同更新时间未按来源质量稳定决胜；预算未完整覆盖标题和项目符号。
- GREEN 专项：`npm test -- --run server/adapters/sqlite/sqlite-repositories.test.ts server/application/context-assembler.test.ts server/application/thread-summary-service.test.ts server/application/channel-turn-coordinator.test.ts server/application/conversation-session-service.test.ts`，5 个文件、132/132 通过。
- GREEN 全量：`npm test -- --run`，52 个文件、475/475 通过。
- Build：`npm run build` 通过，包括 `tsc --noEmit` 与 Vite production build。
- Diff check：`git diff --check` 通过。

## 增量与边界

- 可见水位优先使用仓储返回的稳定顺序，不修改全局消息排序；删除水位 fallback 仍使用持久化的时间与 ID，测试覆盖同毫秒、ID 逆序和水位删除。
- Summary 刷新入口已经通过 Coordinator 可选依赖接入并覆盖成功、失败不阻断与 Timeline 不调用。当前 composition root 尚未提供具体 Summary generator，因此默认构造的 Coordinator 不会自动刷新；具体 generator 与运行时注入留给后续 Dream 编排任务。
- Summary 刷新失败时，ContextAssembler 会继续使用旧 Summary 及水位后的公开消息，保持当前对话可用。

## 改动文件

- `server/domain/memory.ts`
- `server/ports/repositories.ts`
- `server/adapters/sqlite/schema.ts`
- `server/adapters/sqlite/sqlite-repositories.ts`
- `server/adapters/sqlite/sqlite-repositories.test.ts`
- `server/application/context-assembler.ts`
- `server/application/context-assembler.test.ts`
- `server/application/thread-summary-watermark.ts`
- `server/application/thread-summary-service.ts`
- `server/application/thread-summary-service.test.ts`
- `server/application/channel-turn-coordinator.ts`
- `server/application/channel-turn-coordinator.test.ts`
- `server/application/conversation-session-service.test.ts`

## 残余风险

- `tokenBudget` 沿用既有参数名，但实现按需求简报使用字符数而非模型 tokenizer 计数；后续若切换为真实 token 预算，需要统一替换成本函数和相应测试。
- Thread Summary 的具体生成器和 composition root 注入尚未属于本任务；可选 Coordinator 入口已就绪且失败隔离已验证，但在后续编排接线前 Summary 只会由显式注入方刷新。
