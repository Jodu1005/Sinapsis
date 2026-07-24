# 本机 Agent 工作空间实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有的静态“控制室”原型升级为本机可持久化的 Agent 工作空间：用户能按代码仓在频道中协作，创建带验收标准的任务，由空闲且匹配的 OpenCode 或 Pi Agent 严格 FIFO 地领取，在独立 Git worktree 中执行，并把可审查的结果带回频道与任务详情。

**Architecture:** 浏览器是 Slack 式控制台，只通过 REST 查询/命令和 SSE 领域事件与本机服务通信。服务以 SQLite 为唯一真相来源，应用层负责仓库、频道、任务、租约、会话和审查用例；调度器在数据库事务中领取任务；执行协调器为任务建立 Git worktree，再调用统一 `RuntimeAdapter`。OpenCode 以短生命周期的 `run --format json` 逐轮执行并复用 session；Pi 以持久 JSONL RPC 进程执行并用 `steer` 在安全点追加输入。Runtime 原始输出只进任务证据，关键状态由领域事件投递到频道。

**Tech Stack:** Node.js 25、`node:sqlite`、Express、SSE、`child_process`、Git CLI、Vite、React、TypeScript、Vitest、React Testing Library、Lucide React、原生 CSS。

## Global Constraints

- 以 [已确认设计](../specs/2026-07-24-local-agent-workspace-design.md) 与 [功能树](../../../specs/feature-tree.md) 为范围依据；不提前实现频道多 Agent 发布订阅、远程 Worker、任务优先级或自动合并。
- SQLite 数据库、运行日志和 worktree 都必须位于用户配置的本机数据目录；默认目录为 `~/.sinapsis`，测试只能使用临时目录。
- `node:sqlite` 已在当前 Node 25 环境验证可用；不添加 `better-sqlite3` 或其他原生数据库依赖。
- 所有状态写入先落 SQLite、再广播 SSE。客户端重连必须先用快照恢复，不能依赖事件不丢失。
- 每项任务只能有一个有效租约；每个 Agent 在第一版并发数恒为 1；默认队列只按 `queued_at ASC` 领取，不能插队。
- Agent 的 `cwd` 必须是其任务 worktree。产品本身不提供 `push`、合并或仓外删除 API；Runtime 启动提示与权限预设明确禁止这些行为。此版本不声称对任意本机 CLI 提供操作系统级沙箱。
- 生产命令必须经由 `ProcessRunner`，测试使用 `FakeProcessRunner` 或 `FakeRuntimeAdapter`，不得因测试调用真实模型或修改用户代码仓。
- 新任务默认新 session；退回或补充要求优先复用保存的 session。OpenCode 在当前轮结束后启动下一轮；Pi 正在流式执行时使用 RPC `steer`。
- 使用 ASCII 的代码、文件名和 Git 提交信息；用户可见文案为中文。
- 不提交 `.codex/` 或 `src/.DS_Store` 这两个当前未跟踪项目；每个计划任务完成后只暂存其列出的相关源文件。

## Target Layout

```text
server/
  main.ts                         Express/SSE 进程入口
  app.ts                          HTTP 路由装配
  config.ts                       数据目录、端口和默认资源限制
  domain/                         服务端实体、状态机与纯函数
  application/                    用例、调度器和执行协调器
  ports/                          持久化、Git、Runtime、事件端口
  adapters/
    sqlite/                       schema、迁移和仓储实现
    git/                          Git worktree 适配器
    runtime/                      OpenCode、Pi、进程与假实现
    sse/                          已持久化事件广播器
  test/                           临时目录、Git fixture 与 fake helpers
src/
  api/                            REST/SSE 客户端和 DTO 映射
  app/                            根状态与页面装配
  domain/                         浏览器只读视图模型
  ui/                             Slack shell、频道、任务、Agent 设置
  styles.css                      桌面优先且窄屏可用的界面样式
docs/superpowers/plans/           本计划
```

## Runtime Contract

服务端的运行时实现必须以以下稳定端口隔离 CLI 差异。`RuntimeEvent` 只保留产品需要的事件；每条原始 JSONL/STDOUT 记录仍写入 `task_artifacts`，便于诊断和以后扩展解析器。

```ts
// server/ports/runtime.ts
export type RuntimeKind = 'opencode' | 'pi'

export type RuntimeEvent =
  | { type: 'started'; runtimeSessionId?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_started'; name: string; callId?: string }
  | { type: 'tool_finished'; name: string; callId?: string; isError: boolean }
  | { type: 'needs_input'; prompt: string }
  | { type: 'settled' }
  | { type: 'failed'; message: string }

export interface RuntimeHandle {
  readonly id: string
  readonly taskSessionId: string
  readonly kind: RuntimeKind
  readonly pid?: number
  sendInput(input: string): Promise<void>
  cancel(): Promise<void>
  events(): AsyncIterable<RuntimeEvent>
  inspect(): Promise<{ exitCode: number | null; signal: string | null }>
}

export interface RuntimeAdapter {
  readonly kind: RuntimeKind
  detect(config: RuntimeLaunchConfig): Promise<RuntimeAvailability>
  start(request: RuntimeStartRequest): Promise<RuntimeHandle>
  resume(request: RuntimeResumeRequest): Promise<RuntimeHandle>
}
```

OpenCode 的适配器调用：

```text
opencode run --format json --dir <task-worktree> --title sinapsis:<task-id> \
  [--model <provider/model>] [--agent <agent-name>] <rendered-task-prompt>

opencode run --format json --session <stored-session-id> --dir <task-worktree> \
  <queued-human-input>
```

Pi 的适配器调用：

```text
pi --mode rpc --session-dir <data-dir>/pi-sessions --name sinapsis:<task-id> \
  [--provider <provider>] [--model <model>]
```

Pi 的 stdin/stdout 必须使用 LF 分隔的 JSONL（不能使用 Node `readline`）。初始任务使用 `{"type":"prompt","message":"Implement the current task and report the result."}`；运行中输入使用 `{"type":"steer","message":"Please address the failing test before continuing."}`；重启后先以 `switch_session` 恢复 `sessionFile`。`agent_settled` 是 Pi 的完成边界。

---

## Task 1: 建立本机服务进程与可测试的 API 基线

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `vite.config.ts`
- Create: `server/config.ts`
- Create: `server/app.ts`
- Create: `server/main.ts`
- Create: `server/test/http-test-server.ts`
- Create: `server/app.test.ts`

- [ ] **Step 1: 加入服务端开发工具并让 TypeScript 同时检查 `server/` 与 `src/`。**

  在 `devDependencies` 加入 `@types/express`、`@types/node`、`concurrently`、`tsx`，在 `dependencies` 加入 `express`。保留现有前端依赖。将脚本改为：

  ```json
  {
    "dev:api": "tsx watch server/main.ts",
    "dev:web": "vite",
    "dev": "concurrently -k -n api,web -c cyan,magenta \"npm:dev:api\" \"npm:dev:web\"",
    "build": "tsc --noEmit && vite build",
    "test": "vitest",
    "test:run": "vitest run"
  }
  ```

  `tsconfig.json` 的 `include` 改为 `['src', 'server', 'vite.config.ts']`，并将 `types` 设为 `['node']`。`vite.config.ts` 增加开发代理：`/api` 与 `/events` 都转发到 `http://127.0.0.1:4174`。

- [ ] **Step 2: 先写失败的健康检查测试。**

  `server/app.test.ts` 通过临时 HTTP server 请求 `GET /api/health`，期望：

  ```ts
  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ status: 'ok' })
  ```

  运行：`npm run test -- --run server/app.test.ts`

  预期：FAIL，因为 `createApp` 尚不存在。

- [ ] **Step 3: 实现最小但真实的 Express 装配。**

  `server/config.ts` 解析 `SINAPSIS_DATA_DIR`、`SINAPSIS_PORT`，默认数据目录为 `path.join(homedir(), '.sinapsis')`、端口为 `4174`；生产入口使用 `mkdir(..., { recursive: true })`。`server/app.ts` 导出 `createApp()` 并返回 JSON 的 `/api/health`。`server/main.ts` 监听 `127.0.0.1`，处理 `SIGINT`/`SIGTERM` 的优雅关闭。

- [ ] **Step 4: 验证服务与现有前端都能工作。**

  运行：

  ```bash
  npm install
  npm run test -- --run server/app.test.ts
  npm run build
  ```

  预期：健康检查测试通过；构建通过且原型页面尚可编译。

- [ ] **Step 5: 提交服务基线。**

  ```bash
  git add package.json package-lock.json tsconfig.json vite.config.ts server
  git commit -m "feat: add local service baseline"
  ```

## Task 2: 建立 SQLite 真相来源、领域状态机和事件投递

**Files:**
- Create: `server/domain/workspace.ts`
- Create: `server/domain/agent.ts`
- Create: `server/domain/task.ts`
- Create: `server/domain/message.ts`
- Create: `server/domain/events.ts`
- Create: `server/ports/repositories.ts`
- Create: `server/ports/domain-event-publisher.ts`
- Create: `server/adapters/sqlite/database.ts`
- Create: `server/adapters/sqlite/schema.ts`
- Create: `server/adapters/sqlite/sqlite-repositories.ts`
- Create: `server/adapters/sse/sse-domain-event-publisher.ts`
- Create: `server/adapters/sqlite/sqlite-repositories.test.ts`
- Modify: `server/app.ts`

- [ ] **Step 1: 写入测试定义领域不变量。**

  测试必须使用 `mkdtemp(path.join(tmpdir(), 'sinapsis-'))` 创建数据库并在 `afterEach` 删除临时目录。先覆盖三项行为：频道消息与对应领域事件必须在事务提交后才对订阅者可见；`accepted` 任务不可转回 `queued`；删除或改写人类可读频道文案不能改变任务状态。

  运行：`npm run test -- --run server/adapters/sqlite/sqlite-repositories.test.ts`

  预期：FAIL，因仓储与 schema 尚未实现。

- [ ] **Step 2: 定义枚举、DTO 与显式状态转换。**

  `TaskStatus` 必须为：`queued`、`claimed`、`running`、`waiting_input`、`in_review`、`accepted`、`returned`、`needs_human`、`merged`、`cancelled`。只在 `transitionTask(task, next, reason)` 内检查合法转换，非法转换抛出 `DomainError`。Agent 状态为 `offline`、`idle`、`busy`、`error`；session 状态为 `preparing`、`running`、`input_queued`、`completed`、`cancelled`、`failed`、`timed_out`。

- [ ] **Step 3: 初始化 SQLite schema 与迁移版本。**

  使用 `DatabaseSync`，所有写入用 prepared statements，所有业务修改使用 `database.transaction()`。创建 `schema_migrations`、`workspaces`、`repositories`、`channels`、`agents`、`tasks`、`task_label_overrides`、`task_sessions`、`task_input_queue`、`task_leases`、`messages`、`task_events`、`task_artifacts`、`review_decisions` 表。

  `tasks` 至少保存 `repository_id`、`channel_id`、`direct_agent_id`、`title`、`description`、`acceptance_criteria`、`labels_json`、`status`、`queued_at`、`attempt_count`、`max_retries`、`timeout_ms`、`branch_name`、`worktree_path`、`created_at`、`updated_at`。为 `(repository_id, status, queued_at)` 和 `task_leases(task_id, expires_at)` 创建索引。

- [ ] **Step 4: 实现仓储和“提交后才发布”的事件层。**

  `SqliteUnitOfWork.afterCommit(event)` 在事务成功后把事件交给 `SseDomainEventPublisher`。SSE 事件至少包含 `{ id, type, occurredAt, entityType, entityId }`，浏览器收到后重新获取相关快照，避免把事件当作完整状态。`GET /events` 返回 `text/event-stream`，保持客户端集合并在请求关闭时清理。

- [ ] **Step 5: 重新运行测试并补充 API 快照路由。**

  增加 `GET /api/bootstrap`，返回一个工作空间及其仓库、频道、Agent、任务摘要和最近消息；空库返回 `workspaces: []`。运行：

  ```bash
  npm run test -- --run server/adapters/sqlite/sqlite-repositories.test.ts server/app.test.ts
  npm run build
  ```

  预期：全部 PASS。

- [ ] **Step 6: 提交持久化底座。**

  ```bash
  git add server
  git commit -m "feat: persist workspace domain in sqlite"
  ```

## Task 3: 实现工作空间、仓库、频道与 Agent 配置用例

**Files:**
- Create: `server/application/workspace-service.ts`
- Create: `server/application/agent-service.ts`
- Create: `server/application/runtime-profile-service.ts`
- Create: `server/ports/git-client.ts`
- Create: `server/adapters/git/git-client.ts`
- Create: `server/adapters/runtime/runtime-profile.ts`
- Create: `server/application/workspace-service.test.ts`
- Create: `server/application/agent-service.test.ts`
- Modify: `server/app.ts`

- [ ] **Step 1: 写入失败用例测试。**

  测试应验证：添加目录时调用 `git rev-parse --show-toplevel`；非 Git 目录被拒绝；新仓库默认创建 `general` 频道；Agent 必须绑定现有工作空间且固定 `maxConcurrentTasks: 1`；重复的 mention 被拒绝；覆盖配置不会丢弃预设字段。

  运行：`npm run test -- --run server/application/workspace-service.test.ts server/application/agent-service.test.ts`

  预期：FAIL。

- [ ] **Step 2: 实现 Git 仓库验证与工作空间命令。**

  `GitClient.inspectRepository(path)` 只能调用参数数组形式的 Git：`git -C <path> rev-parse --show-toplevel`、`symbolic-ref --short HEAD`、`status --porcelain=v1`。`POST /api/workspaces` 创建工作空间；`POST /api/workspaces/:id/repositories` 只接收本机目录，保存规范化 Git root、当前分支和默认目标分支；`POST /api/repositories/:id/channels` 创建频道。

- [ ] **Step 3: 实现 Agent 表单与 Runtime 预设。**

  `RuntimeProfile` 的预设必须是：

  ```ts
  const runtimePresets = {
    opencode: { command: 'opencode', args: ['run'], model: '', env: {}, policy: 'task-worktree' },
    pi: { command: 'pi', args: ['--mode', 'rpc'], model: '', env: {}, policy: 'task-worktree' },
  } as const
  ```

  `POST /api/workspaces/:id/agents` 接收 identity、mention、runtime、capabilityTags、command/model/args/env 覆盖。环境变量以 JSON 对象保存，但 `GET` 响应只回显变量名，不回显值。配置保存前调用 runtime adapter 的 `detect()`；“可执行文件存在”与“可执行任务”分列显示。

- [ ] **Step 4: 加入 API 级输入校验。**

  所有 mutating route 检查 JSON 类型、非空字符串、数组元素和 ID 所属工作空间。不要把 `req.body` 直接传到应用服务。用错误中间件将 `DomainError` 转为 409、验证错误转为 400、找不到转为 404。

- [ ] **Step 5: 验证并提交。**

  ```bash
  npm run test -- --run server/application/workspace-service.test.ts server/application/agent-service.test.ts
  npm run build
  git add server
  git commit -m "feat: manage repositories channels and agents"
  ```

## Task 4: 用端口适配 OpenCode 与 Pi，并可靠记录运行证据

**Files:**
- Create: `server/ports/process-runner.ts`
- Create: `server/ports/runtime.ts`
- Create: `server/adapters/runtime/lf-jsonl-parser.ts`
- Create: `server/adapters/runtime/opencode-runtime-adapter.ts`
- Create: `server/adapters/runtime/pi-runtime-adapter.ts`
- Create: `server/adapters/runtime/fake-runtime-adapter.ts`
- Create: `server/test/fake-process-runner.ts`
- Create: `server/adapters/runtime/opencode-runtime-adapter.test.ts`
- Create: `server/adapters/runtime/pi-runtime-adapter.test.ts`
- Create: `server/adapters/runtime/lf-jsonl-parser.test.ts`

- [ ] **Step 1: 先写协议级失败测试。**

  `lf-jsonl-parser.test.ts` 必须验证只以 `\n` 断帧、保留 JSON 字符串中的 `U+2028/U+2029`、接受 `\r\n`、并把不完整尾部留给下一块。Pi 测试必须断言启动参数包括 `--mode rpc`，首条 stdin 为 `prompt`，流式时第二条为 `steer`，收到 `agent_settled` 后产生 `settled`。OpenCode 测试必须断言新任务使用 `run --format json --dir`，后续输入使用已保存 session 的 `--session`，绝不把用户文本拼进 shell 字符串。

  运行：

  ```bash
  npm run test -- --run server/adapters/runtime/lf-jsonl-parser.test.ts server/adapters/runtime/opencode-runtime-adapter.test.ts server/adapters/runtime/pi-runtime-adapter.test.ts
  ```

  预期：FAIL。

- [ ] **Step 2: 统一实现受控子进程端口。**

  `ProcessRunner.spawn({ command, args, cwd, env })` 必须通过 `child_process.spawn(command, args, { cwd, env, shell: false })` 启动；其 `env` 是 `process.env` 与 Agent 已允许的覆盖变量合并，而非任意浏览器输入。测试 fake 要能注入 stdout/stderr、退出码与 stdin 记录。

- [ ] **Step 3: 实现 OpenCode 逐轮适配器。**

  `detect()` 用 `<command> --version`，并在超时内返回 `available`、`missing` 或 `unhealthy`，但不发模型请求。`start()` 渲染含任务、验收标准、worktree 限制和禁止 push/merge 的系统提示，采用上文的参数数组启动。逐行保存原始事件；解析可识别的 text/tool/error/session 字段为 `RuntimeEvent`，未知 JSON 只作为原始 artifact。当前轮退出才消费 `task_input_queue` 并以 stored OpenCode session 再起下一轮，保证不会中断 CLI 的工具调用。

- [ ] **Step 4: 实现 Pi RPC 适配器。**

  Pi 的 process 生命周期绑定一个任务 session。启动后发送 `get_state`，从响应保存 `sessionId`、`sessionFile`；初始任务用 `prompt`。收到 `message_update` 的 `text_delta` 发 `text`，`tool_execution_start/end` 映射工具事件，`queue_update` 更新会话队列长度，`agent_settled` 完成任务轮。若须恢复，启动新的 RPC 进程、发送 `switch_session` 并在成功后发送 pending human input。`sendInput()` 在 `isStreaming` 时使用 `steer`，否则使用 `prompt`。

- [ ] **Step 5: 建立 Runtime 可观测性。**

  每个 stdout/stderr chunk、命令元数据、退出状态写入 `task_artifacts`，artifact 类型为 `runtime-jsonl`、`runtime-stderr`、`runtime-exit`。频道绝不展示它们；仅由后续执行协调器提炼为里程碑消息。

- [ ] **Step 6: 验证并提交。**

  ```bash
  npm run test -- --run server/adapters/runtime
  npm run build
  git add server
  git commit -m "feat: add managed opencode and pi adapters"
  ```

## Task 5: 用 Git worktree 隔离任务，并实现任务输入与标签推断

**Files:**
- Create: `server/application/task-service.ts`
- Create: `server/application/capability-labeler.ts`
- Create: `server/ports/worktree-manager.ts`
- Create: `server/adapters/git/git-worktree-manager.ts`
- Create: `server/test/git-fixture.ts`
- Create: `server/application/task-service.test.ts`
- Create: `server/adapters/git/git-worktree-manager.test.ts`
- Modify: `server/app.ts`

- [ ] **Step 1: 写失败的任务与 worktree 测试。**

  使用 `createGitFixture()` 初始化临时 Git 仓、首个提交和 `main` 分支。测试应断言：

  ```ts
  expect(task.labels).toEqual(['frontend', 'test'])
  expect(await manager.create(taskA)).not.toEqual(await manager.create(taskB))
  expect(taskA.branchName).not.toBe(taskB.branchName)
  ```

  另测人在创建面板改写 labels 后，保存的就是改写值；任务只能继承当前代码仓与其默认限制。

- [ ] **Step 2: 实现可解释的标签器与任务 API。**

  `inferCapabilityTags` 先使用明确可测试的关键词表，而不是调用模型：例如 `test|测试|vitest` => `test`，`React|CSS|UI|界面` => `frontend`，`API|schema|数据库` => `backend`，`review|审查` => `review`。未知任务标为 `general`。`POST /api/repositories/:id/tasks` 创建 `queued` 任务、记录 `labels_inferred` 事件并允许 `labels` 覆盖；字段只接受 title、description、acceptanceCriteria、labels、optional directAgentId、optional timeoutMs/maxRetries。

- [ ] **Step 3: 实现不可碰撞的 worktree 命名。**

  `GitWorktreeManager.create(task)` 使用：

  ```text
  branch: sinapsis/task-<task-id>
  path: <data-dir>/worktrees/<repository-id>/<task-id>
  git -C <repository-root> worktree add -b <branch> <path> <target-branch>
  ```

  创建前确认目标路径不在任一 repository root 内，且路径位于数据目录的 `worktrees` 根下。完成任务不会自动移除 worktree；单独的清理命令只能在用户确认后调用。

- [ ] **Step 4: 添加任务、详情与人工提交输入 API。**

  实现：`GET /api/repositories/:id/tasks`、`GET /api/tasks/:id`、`POST /api/tasks/:id/input`、`POST /api/tasks/:id/cancel`。`GET` 详情必须区分结构化任务/会话/租约/人工决定与 artifact 元数据；原始日志内容由 `GET /api/tasks/:id/artifacts/:artifactId` 按需读取。

- [ ] **Step 5: 验证并提交。**

  ```bash
  npm run test -- --run server/application/task-service.test.ts server/adapters/git/git-worktree-manager.test.ts
  npm run build
  git add server
  git commit -m "feat: create labeled tasks in isolated worktrees"
  ```

## Task 6: 实现严格 FIFO 租约调度、心跳与有限重试

**Files:**
- Create: `server/application/task-scheduler.ts`
- Create: `server/application/lease-reaper.ts`
- Create: `server/application/task-scheduler.test.ts`
- Create: `server/application/lease-reaper.test.ts`
- Modify: `server/adapters/sqlite/sqlite-repositories.ts`
- Modify: `server/main.ts`

- [ ] **Step 1: 写会竞争的领取测试。**

  用同一个临时 SQLite 数据库并发调用两次 `claimNext(agentId)`；期望只返回一个 task id。再覆盖：最早且标签相符的任务先领取、Agent 忙碌不能领取、labels 不匹配不能领取、`directAgentId` 只能被指定的空闲 Agent 领取、同一 Agent 没有第二个活跃租约。

  运行：`npm run test -- --run server/application/task-scheduler.test.ts server/application/lease-reaper.test.ts`

  预期：FAIL。

- [ ] **Step 2: 实现单事务领取。**

  `claimNext(agentId, now)` 的 SQLite transaction 顺序固定为：读取并确认 Agent 是 `idle`；读取其 direct task 或按 `queued_at ASC` 的候选；用 TS 纯函数筛标签；条件更新 `tasks.status = 'claimed' WHERE id = ? AND status = 'queued'`；插入 lease；更新 Agent 为 `busy`；写 task event。条件更新为 0 行时重查候选，绝不“猜测已领取成功”。

- [ ] **Step 3: 接入心跳与生命周期。**

  每个运行任务每 10 秒续约一次，lease TTL 默认 30 秒；值从 workspace/task 覆盖读取。`LeaseReaper` 每 5 秒查询过期 lease：终止其 process、把 session 标为 `timed_out`，若 `attempt_count < max_retries` 则递增、重新设置为 `queued` 并归还 Agent `idle`，否则转为 `needs_human`。所有分支都写可见任务事件和一条关键频道消息。

- [ ] **Step 4: 服务启动、停止时管理调度器。**

  `server/main.ts` 装配一个 `SchedulerLoop`：每秒尝试为空闲 Agent 领取任务；进程关闭时停止 interval、取消正在清理的定时器、关闭数据库与 SSE 客户端。不要在 HTTP handler 内启动重复的 loop。

- [ ] **Step 5: 验证并提交。**

  ```bash
  npm run test -- --run server/application/task-scheduler.test.ts server/application/lease-reaper.test.ts
  npm run build
  git add server
  git commit -m "feat: schedule tasks with fifo leases"
  ```

## Task 7: 用执行协调器连接调度、Runtime、Git 与人工控制

**Files:**
- Create: `server/application/task-execution-coordinator.ts`
- Create: `server/application/task-review-service.ts`
- Create: `server/application/channel-message-service.ts`
- Create: `server/application/task-execution-coordinator.test.ts`
- Create: `server/application/task-review-service.test.ts`
- Modify: `server/application/task-scheduler.ts`
- Modify: `server/app.ts`

- [ ] **Step 1: 写端到端的 fake runtime 测试。**

  使用临时 Git fixture 和 `FakeRuntimeAdapter`，验证：领取后创建 worktree、Agent 从 `idle` 变 `busy`、任务从 `claimed` 到 `running`、raw event 只进 artifact、里程碑发频道消息；Runtime 完成但没有 task branch commit 时任务转 `needs_human`；有提交时转 `in_review`；`accept` 不调用 Git merge/push；`return` 首选 `runtime.resume`；运行中的 `@agent` 消息由 Pi adapter 变成 `steer` 或由 OpenCode 放入下一轮队列。

- [ ] **Step 2: 按状态拆分协调器职责。**

  `TaskExecutionCoordinator.startClaim(claim)` 先调用 worktree manager，再创建 session 和启动 runtime。`for await` 消费 RuntimeEvent：

  - `text`/tool 事件写 artifact 与 session event；
  - `needs_input` 将 task 转 `waiting_input`，在频道创建“需要决定”的简短消息；
  - `settled` 检查 `git -C <worktree> log <target>..HEAD --format=%H -1`；
  - `failed`/非 0 exit 走重试/人工处理规则。

  仅将“开始执行、关键步骤、需要输入、失败、完成摘要”写入 `messages`。不要将每个 token、tool stdout 或测试整段输出发到频道。

- [ ] **Step 3: 实现频道消息与 `@Agent` 语义。**

  `POST /api/channels/:id/messages` 一律先保存普通消息。解析精确 `@mention`：若对应 Agent 空闲且消息绑定一个新任务，调用直接领取；若 Agent 忙碌，查其唯一 active session，把内容写入 `task_input_queue`，并由 coordinator 调用 `handle.sendInput`。普通频道消息不唤醒任何 Agent。

- [ ] **Step 4: 实现人工验收，不实现自动合并。**

  `POST /api/tasks/:id/review` 的 body 为 `{ action: 'accept' | 'return', message }`。接受仅写 `review_decisions` 和 `accepted` 状态；退回写决策、入队输入并恢复原 session。`POST /api/tasks/:id/merge` 固定返回 `501` 与“第一版只记录验收，合并需要独立人工流程”，使 UI 不会假装提供该能力。

- [ ] **Step 5: 验证并提交。**

  ```bash
  npm run test -- --run server/application/task-execution-coordinator.test.ts server/application/task-review-service.test.ts
  npm run test:run
  npm run build
  git add server
  git commit -m "feat: coordinate runtime execution and review"
  ```

## Task 8: 将旧控制室替换为 Slack 式频道工作台

**Files:**
- Create: `src/api/client.ts`
- Create: `src/api/use-workspace-events.ts`
- Create: `src/domain/workspace-view.ts`
- Create: `src/ui/WorkspaceShell.tsx`
- Create: `src/ui/RepositorySidebar.tsx`
- Create: `src/ui/ChannelTimeline.tsx`
- Create: `src/ui/MessageComposer.tsx`
- Create: `src/ui/AgentStatusList.tsx`
- Create: `src/ui/WorkspaceSetup.tsx`
- Create: `src/ui/WorkspaceShell.test.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/styles.css`
- Delete: `src/adapters/in-memory-control-room.ts`
- Delete: `src/application/control-room-service.ts`
- Delete: `src/application/control-room-service.test.ts`
- Delete: `src/domain/control-room.ts`
- Delete: `src/ports/control-room-store.ts`
- Delete: `src/ui/ControlRoomPage.tsx`
- Delete: `src/ui/ControlRoomPage.test.tsx`
- Delete: `src/ui/ProjectSidebar.tsx`
- Delete: `src/ui/ReviewActions.tsx`
- Delete: `src/ui/TaskBoard.tsx`
- Delete: `src/ui/TaskCard.tsx`
- Delete: `src/ui/TaskInspector.tsx`
- Delete: `src/ui/Timeline.tsx`
- Delete: `src/ui/use-control-room.ts`

- [ ] **Step 1: 在实现前读取并应用项目安装的 UI 设计 skill。**

  读取 `.codex/skills/ui-ux-pro-max/SKILL.md`，使用其中与 desktop collaboration/Slack 信息密度相关的建议。不要复刻 Slack 的商标、品牌色或文案；目标是熟悉的三栏协作人体工学，而不是像素复制。

- [ ] **Step 2: 先写失败的 UI 行为测试。**

  Mock `ApiClient` 和 EventSource。测试覆盖：首次无工作空间时显示创建/添加仓库流程；左栏按 repository 分组频道；选择频道加载消息；普通发送调用 channel API；收到 `task.changed` SSE 后重新拉取并更新 Agent 状态；窄屏下左右栏收起且中间消息区仍可操作。

  运行：`npm run test -- --run src/ui/WorkspaceShell.test.tsx`

  预期：FAIL。

- [ ] **Step 3: 实现数据客户端、快照优先和 SSE 刷新。**

  `ApiClient` 是唯一 `fetch` 所在处，所有请求发送 `Content-Type: application/json` 并在非 2xx 抛带 API message 的错误。`useWorkspaceEvents` 建立 `EventSource('/events')`，事件只触发受影响 query 的 refresh，断线显示低调“正在重新连接”状态；页面初次与重连后总是从 `/api/bootstrap` 读快照。

- [ ] **Step 4: 实现三栏默认界面。**

  左栏固定 workspace 标识、按代码仓展开的频道、任务入口与 Agent 状态；中栏是频道名、消息流和支持 `@mention` 的 composer；右栏按需显示选中任务/线程/Agent 上下文。使用 Lucide 图标按钮承载折叠、任务、设置和关闭；每个图标有 `aria-label` 和可见 tooltip。页面区段不要套浮动卡片，消息才可有轻量分组面。

- [ ] **Step 5: 编写稳定的响应式样式。**

  桌面 grid 使用 `260px minmax(0, 1fr) minmax(300px, 360px)`；中栏 `min-width: 0`；消息列表保持滚动容器而非让整页无限增长。`@media (max-width: 980px)` 把右栏变为抽屉；`@media (max-width: 700px)` 将左栏改为可关闭导航抽屉。不要用 viewport 直接缩放文字，不使用大面积单一色渐变、装饰性 orb 或嵌套 cards。

- [ ] **Step 6: 验证并提交。**

  ```bash
  npm run test -- --run src/ui/WorkspaceShell.test.tsx
  npm run test:run
  npm run build
  git add src index.html
  git commit -m "feat: replace control room with channel workspace"
  ```

## Task 9: 增加紧凑任务面板、任务证据与人工验收界面

**Files:**
- Create: `src/ui/TaskComposerPanel.tsx`
- Create: `src/ui/TaskList.tsx`
- Create: `src/ui/TaskDetailPanel.tsx`
- Create: `src/ui/RuntimeEvidence.tsx`
- Create: `src/ui/AgentConfigDialog.tsx`
- Create: `src/ui/TaskComposerPanel.test.tsx`
- Create: `src/ui/TaskDetailPanel.test.tsx`
- Modify: `src/ui/WorkspaceShell.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: 写失败 UI 测试。**

  验证任务面板只有标题、详细描述、验收标准与可编辑 labels，当前仓库是继承只读上下文；`@agent` 明确指定时显示该 Agent；提交后不要求用户手选 worktree。验证详情页按“概览、输入队列、证据、审查”显示，且接受不会显示“已合并”。

- [ ] **Step 2: 实现任务创建与列表。**

  `TaskComposerPanel` 由仓库“新任务”图标打开，不进入常驻看板。提交 `POST /api/repositories/:id/tasks` 后关闭面板、跳到任务详情并显示调度状态。`TaskList` 只用五个过滤项：等待、执行中、等待输入、待人工验收、已结束；不支持拖拽排序。

- [ ] **Step 3: 实现证据、输入与审查操作。**

  `RuntimeEvidence` 默认显示 commit、改动文件、测试结果、diff 摘要；完整日志按需请求 artifact endpoint 并用等宽可滚动视图呈现。忙碌 Agent 的右栏输入调用 `POST /api/tasks/:id/input`，回复显示“已排队，当前安全步骤结束后送达”。审查区有接受/退回两个明确按钮；接受后的主文案为“验收已通过，尚未合并”。

- [ ] **Step 4: 实现 Agent 配置可见性。**

  配置对话框显示 Runtime availability、预设、command/model/args、环境变量名和 capability tags。环境变量值只在输入时可编辑，重新打开只显示“已配置”。Agent 运行中禁止改变 Runtime 命令。

- [ ] **Step 5: 验证并提交。**

  ```bash
  npm run test -- --run src/ui/TaskComposerPanel.test.tsx src/ui/TaskDetailPanel.test.tsx
  npm run test:run
  npm run build
  git add src
  git commit -m "feat: add task evidence and human review ui"
  ```

## Task 10: 本机集成验证、浏览器 QA 与文档收束

**Files:**
- Create: `server/integration/local-workspace-flow.test.ts`
- Create: `scripts/runtime-health-check.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-24-local-agent-workspace-design.md`
- Modify: `specs/feature-tree.md`

- [ ] **Step 1: 写可重复的本机流程集成测试。**

  该测试使用临时 data dir、临时 Git repo 与 `FakeRuntimeAdapter`，完整走过：创建 workspace/repository/channel/agent，创建两个并发任务，确认 FIFO 与不同 worktree，发送 busy Agent 输入，完成有 commit 的任务，接受任务，并确认没有 merge/push。它不能依赖 OpenCode/Pi 认证。

- [ ] **Step 2: 增加不调用模型的 Runtime 健康命令。**

  `scripts/runtime-health-check.mjs` 运行 Agent 已配置 command 的 `--version`，以 JSON 输出 `available`、`missing` 或 `unhealthy`。`package.json` 新增 `"runtime:check": "node scripts/runtime-health-check.mjs"`。当前环境应报告 OpenCode available、Pi missing；这不是测试失败条件。

- [ ] **Step 3: 运行完整自动验证。**

  ```bash
  npm run test:run
  npm run build
  npm run runtime:check
  ```

  预期：测试与构建 PASS；runtime check 给出每个 CLI 的明确状态，不发送任何 LLM 请求。

- [ ] **Step 4: 启动真实本机应用并做浏览器验收。**

  启动 `npm run dev`。用 gstack `browse` 或应用内浏览器完成以下路径并截图桌面、窄屏：创建/选择工作空间、添加临时 Git fixture、添加 Agent、发普通消息、创建任务、查看自动领取/状态事件、向运行 Agent 发送输入、打开证据、接受任务。修复发现的浏览器控制台错误、溢出、遮挡和不可点击按钮后重跑相关测试。

- [ ] **Step 5: 更新文档并做范围自审。**

  README 写明本机数据目录、启动命令、如何添加仓库、如何配置 Runtime、Pi 未安装时的状态、工作树清理限制和“不自动 merge/push”的边界。设计文档与功能树将状态从“等待实现计划/已确认设计”改为“第一版已实现”，但只在所有验证完成后修改。检查不存在遗留占位标记、假的成功状态、已删除控制室组件的 import 或未使用 endpoint。

- [ ] **Step 6: 最终提交。**

  ```bash
  git add package.json scripts README.md docs/superpowers/specs/2026-07-24-local-agent-workspace-design.md specs/feature-tree.md server/integration
  git commit -m "docs: verify local agent workspace"
  git status --short
  ```

  预期：只有用户已有的 `.codex/` 与 `src/.DS_Store` 保持未跟踪；本计划不暂存它们。

## Final Review Checklist

- [ ] 对照功能树 F0-F6，每项第一版能力都有后端用例、UI 入口和至少一个自动测试。
- [ ] 对照设计的不变量，检查事务领取、worktree 隔离、Agent 单并发、人工验收与合并分离。
- [ ] 检查所有 CLI 调用都采用 command/args 数组、`shell: false` 和 task worktree `cwd`。
- [ ] 检查所有 Runtime 原始输出落 artifact，频道只展示人工可读的关键事件。
- [ ] 检查 SSE 事件只在 SQLite commit 后发送，前端可从 bootstrap 快照恢复。
- [ ] 检查 OpenCode 缺失 session id、Pi 不存在、认证失败、超时、进程崩溃、无提交完成均呈现为可见状态。
- [ ] 在桌面与 700px 宽度完成浏览器检查，确认侧栏/面板不会挤压消息输入与任务证据。
