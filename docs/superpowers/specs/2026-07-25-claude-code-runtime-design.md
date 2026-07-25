# Claude Code Runtime 设计

## 目标

将本机已登录的 Claude Code 接入 Sinapsis，作为 OpenCode 与 Pi 之外的第三种受管 Runtime。用户创建 Claude Code Agent 后，它可按现有 FIFO、单并发、租约、独立 worktree、任务证据和人工验收流程执行任务。

## 范围

- 新增运行时标识 `claude-code`，默认命令为 `claude`。
- 使用本机已有 Claude Code 登录态和默认模型；不在 Sinapsis 保存 API Key。
- 首轮以 `claude -p --output-format stream-json --permission-mode acceptEdits --session-id <uuid>` 在任务 worktree 启动。
- 追问以 `claude -p --output-format stream-json --permission-mode acceptEdits --resume <stored-session-id>` 启动下一轮。
- 原始流式输出、stderr 和退出信息继续只保存在任务 artifacts；可识别的文本、工具与失败事件走统一 Runtime 事件。
- 健康检查、Agent 创建表单、API runtime 枚举与测试均支持 Claude Code。

## 非目标与边界

- 不使用 `--dangerously-skip-permissions` 或 `--allow-dangerously-skip-permissions`。
- 不改变现有“本机 CLI 没有 OS 级沙箱”的边界；worktree 是受信任本机 CLI 的约定性隔离。
- 不实现 Claude Code 后台 agents、Chrome 集成或 Claude Code 自己的 `--worktree` 参数，Sinapsis 已拥有任务 worktree。
- 验收只记录决定，不自动 merge 或 push。

## 适配器

`ClaudeCodeRuntimeAdapter` 实现现有 `RuntimeAdapter`：

1. 为每项任务生成有效 UUID session ID，并先启动首轮 `--session-id`。
2. 使用 LF JSONL parser 逐条保存原始输出。识别 Claude Code 的 assistant 文本、tool use、result/error 事件；未知事件仅留为 artifact。
3. 正常退出时，如果存在排队输入则先以 `--resume` 发起下一轮；只有最后一轮结束时发出 `settled`。
4. 非零退出和流内 error 发出统一 `error`；`cancel` 仅终止该任务所管理的子进程。
5. 启动元数据中的自定义参数经过现有脱敏规则再写 exit artifact。

## 数据与界面

`RuntimeKind`、运行时 preset、Agent 类型、Agent 创建下拉框、健康检查默认项扩展为 `claude-code`。已有数据库的 runtime 字段存储为文本，无需 schema migration。Agent 创建仍通过 `claude --version` 探测；可执行但尚未真实完成任务时进入 idle，缺失或不健康时保持 offline。

## 验证

- 适配器测试覆盖首轮参数、UUID session、流式事件、成功结算、带输入续轮、非零退出、取消与参数脱敏。
- Agent/API 测试覆盖 `claude-code` runtime preset 与创建。
- 健康检查测试或脚本输出包含 Claude Code。
- 全量 `npm run test:run`、`npm run build`、`npm run runtime:check` 通过；本机健康检查显示 Claude Code 可用。
