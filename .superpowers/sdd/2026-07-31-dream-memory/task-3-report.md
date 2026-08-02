# Task 3 Report: Safe Memory Consolidation

## 实现内容

- 新增严格 Memory consolidation 协议，只接受顶层 `candidates` JSON 对象和单层 JSON Markdown fence；拒绝未知/缺失字段、未知 scope/kind、空文本、非有限或越界分数、伪造/重复来源及超过配置上限的候选。
- 对即将持久化的 content 与 rationale 执行安全过滤，拒绝秘密、Token、Cookie、`.env` 值、凭据路径、临时状态、一次性错误和未经确认猜测，并返回字段与拒绝类别。
- 导出与仓储一致的 trim 规范化和 SHA-256 内容 hash，供 consolidator 去重并保持持久化 hash 口径一致。
- 新增独立 `MemoryConsolidator`，每次 Dream 使用单个注入的 RuntimeAdapter，在 `${dataDir}/dream/<runId>` 启动一次性 read-only conversation request；不设置 conversation metadata，不经过 `ConversationSessionService`，也不复用或恢复频道 session。
- Runtime prompt 是白名单投影后的安全 JSON：只包含当前 channel 公共字段、同 channel 未删除 messages、settled response/handoff response 的 public reply，以及 active Global/current-channel accepted memories。真实 `ConversationSessionResult.parsed.reply` 与旧顶层 reply 均受支持。
- text 事件只在 settled 后整体严格解析；解析失败、Runtime error 和 timeout 均不会创建部分候选。timeout 覆盖 `runtime.start()`，operation 到点立即拒绝，晚到 session 会被单独取消。
- Runtime artifact 仅写入 run 目录的本机证据文件，不进入 Candidate 或频道消息。跨频道 message/Turn 和包含路径字符的不安全 runId 在创建目录和启动 Runtime 前直接拒绝；constructor 同时验证 timeout 为正整数、候选上限为 1..50。
- 重复候选按相关 accepted Memory 的 scope 与规范化 hash 消除。冲突仅在相同 scope/kind 且共享规范化 subject/key 时标注，并追加明确的人工审核 rationale；归档或其他频道 Memory 不参与比较。
- 配置新增 `dreamRuntime`、`dreamModel`、`dreamTimeoutMs`、`maxDreamCandidatesPerRun`，对应 `SINAPSIS_DREAM_*` 环境变量，默认分别为 `pi`、空字符串、120000 和 20；候选硬上限为 50。

## RED / GREEN

- 协议 RED：初始 stub 下 20 tests 中 7 条合法路径失败；最薄 happy-path 后 17 条严格校验与安全边界逐行为失败，证明拒绝测试不是统一 stub 假绿。
- 协议 GREEN：20/20 通过，敏感与临时内容逐条返回可诊断拒绝类别。
- Runtime 初始 RED：stub 后 10/10 行为测试失败，覆盖独立目录、安全 prompt、settled、no-op、重复/冲突、原子失败、取消和 artifact 隔离。
- Runtime 边界 RED：15 tests 中 5 条失败，分别命中真实 `parsed.reply`、start hang timeout、跨频道 message、相关 Memory 过滤和无关冲突误标。
- Runtime GREEN：15/15 通过。
- Fix round 1 RED：18 tests 中 14 条通过、4 条失败，分别命中 task mode 可写、跨频道 Turn、runId 目录逃逸和 constructor 缺少边界校验。
- Fix round 1 GREEN：18/18 通过；Dream 改用一次性 read-only conversation mode，且仍不设置 conversation metadata 或复用 ConversationSessionService。
- Config RED：13 tests 中原有 8 条通过，新增 5 条默认值/覆盖/非法值测试失败。
- Config GREEN：13/13 通过。
- 最终专项：`npm test -- --run server/application/memory-consolidation-protocol.test.ts server/application/memory-consolidator.test.ts server/config.test.ts`，3 个文件、51/51 通过。
- 最终全量：`npm test -- --run`，54 个文件、532/532 通过。
- Build：`npm run build` 通过，包括 `tsc --noEmit` 与 Vite production build。
- Diff check：`git diff --check` 通过。

## 改动文件

- `server/application/memory-consolidation-protocol.ts`
- `server/application/memory-consolidation-protocol.test.ts`
- `server/application/memory-consolidator.ts`
- `server/application/memory-consolidator.test.ts`
- `server/config.ts`
- `server/config.test.ts`
- `.superpowers/sdd/2026-07-31-dream-memory/task-3-brief.md`
- `.superpowers/sdd/2026-07-31-dream-memory/task-3-report.md`
- `.superpowers/sdd/2026-07-31-dream-memory/progress.md`

## 残余风险

- 冲突 subject/key 使用确定性语言模式而非语义模型；无法可靠抽取 key 的内容会保守地不自动标冲突，仍可由人工在 Candidate 审核阶段判断。
- 本任务只实现协议、独立 Runtime 提取服务和配置。Dream 调度、Run 状态编排及 production composition root 接线属于 Task 4。
