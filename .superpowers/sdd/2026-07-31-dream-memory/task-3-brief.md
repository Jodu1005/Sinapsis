### Task 3: 实现 MemoryConsolidator 的安全提取与去重

> 执行澄清：Dream 是独立维护调用，不得复用 `ConversationSessionService`、频道 Agent session 或任务队列。`MemoryConsolidator` 的输入增加 `runId`，用于固定工作目录 `${dataDir}/dream/<runId>`。本任务只实现协议、提取服务与配置；调度、Run 状态编排和生产 composition root 接线属于 Task 4。

**Files:**
- Create: `server/application/memory-consolidation-protocol.ts`
- Create: `server/application/memory-consolidation-protocol.test.ts`
- Create: `server/application/memory-consolidator.ts`
- Create: `server/application/memory-consolidator.test.ts`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`

**Required behavior:**

1. 严格接受一个 JSON 对象，顶层只能有 `candidates`；可去除单层 Markdown JSON fence。
2. 每个 candidate 只能包含 `scope`、`kind`、`content`、`rationale`、`confidence`、`importance`、`sourceMessageIds`。
3. 拒绝未知字段、未知枚举、空文本、非有限数值、超出 `0..1` 的分数、伪造来源 ID 和重复来源 ID。
4. 空数组是合法 no-op；结果数量受配置限制，默认 20，配置硬上限 50。
5. 拒绝秘密、Token、Cookie、`.env` 值、凭据路径、临时状态、一次性报错和未经确认猜测。过滤必须在持久化前执行，不能只依赖 Prompt。
6. 与已接受 Memory 规范化后完全相同时不创建候选；同 scope 下内容存在明显冲突时保留候选，并在 rationale 中标注潜在冲突，交由人类审核。
7. 使用 SHA-256 规范化内容哈希；优先复用仓储已有内容规范化语义，避免协议层和持久化层产生不同哈希口径。
8. Runtime 请求只读取调用方传入的公开消息和 Turn 结果；不得加入 Runtime 原始日志、Artifact、环境变量、私有推理或其他频道内容。
9. Runtime Artifact 可以写入 `${dataDir}/dream/<runId>` 作为本机证据，但不能写入频道消息或 MemoryCandidate。
10. Runtime 超时必须取消 session 并返回可诊断错误；不得留下活跃 session。解析失败不得创建部分候选。

**Config:**

```ts
dreamRuntime: RuntimeKind             // 默认 pi
dreamModel: string                    // 默认空字符串，沿用运行时默认模型
dreamTimeoutMs: number                // 默认 120_000，正整数
maxDreamCandidatesPerRun: number      // 默认 20，范围 1..50
```

环境变量采用现有 `SINAPSIS_*` 命名风格，并为默认值、合法覆盖、非法 runtime、非正 timeout、候选数超过 50 编写测试。

**TDD order:**

1. 先写协议解析、来源白名单、敏感/临时内容过滤和去重冲突的 RED 测试。
2. 写 Runtime 成功、空结果、结构错误、超时取消、独立目录、Artifact 隔离的 RED 测试。
3. 写配置 RED 测试。
4. 实现最小 GREEN；不要提前实现 Scheduler/API/UI。
5. 运行：

```bash
npm test -- --run server/application/memory-consolidation-protocol.test.ts server/application/memory-consolidator.test.ts server/config.test.ts
npm test -- --run
npm run build
git diff --check
```

6. 只提交本任务相关文件与 SDD report/ledger，commit message：

```text
feat: consolidate memory candidates safely
```

**Global constraints:**

- 不修改、暂存或删除 `.codex/` 与 `src/.DS_Store`。
- 你不是代码库中唯一工作者；不得回退他人改动。
- 所有过程和最终报告使用中文。
