# 频道 Agent 对话设计

## 目标

让频道成为人类与 Agent 的真实对话空间：每条人类普通消息都至少获得一个 Agent 回复，同时保留 `/task` 作为独立、可审查的代码任务入口。

## 交互规则

- 每个频道默认订阅所属工作空间的全部 Agent。
- 人类发送不带 `/task` 的消息时，由该工作空间中最先空闲的 Agent 回复。
- 消息含精确 `@mention` 时，提及的 Agent 优先回复。
- 被提及的 Agent 正在执行代码任务时，频道内以该 Agent 身份确认已收到，并将该消息排入其待回复队列；不会把聊天消息注入无关的代码任务 Runtime。
- `/task` 仍创建现有代码任务：它有 worktree、队列、提交、验收和任务状态；它不作为聊天回复机制。

## 架构

新增 `ConversationCoordinator`，与 `TaskExecutionCoordinator` 并列。它负责选择回复 Agent、维护运行中的频道会话、向 Runtime 发送人类输入，并将 Agent 的最终文本写回频道。

对话运行复用现有 OpenCode、Pi、Claude Code Runtime 适配器，但 Runtime 请求新增 `conversation` 模式：

- 工作目录使用频道所属工作目录，不创建 task worktree。
- 初始提示明确为只读对话：不得编辑文件、不得运行破坏性命令、不得 push 或 merge。
- 适配器输出的原始 JSONL、stdout、stderr 不写入频道；只保留聚合后的 Agent 文本回复。
- Runtime 进程和会话状态在内存中维护。服务重启时不恢复旧进程，而是在下一条人类消息上用频道最近消息重新开始上下文。

频道会话不进入 `tasks`、`task_sessions`、任务审查或任务证据模型。它只使用既有 `messages` 作为对话历史和展示载体。

## 投递与并发

1. `POST /api/channels/:channelId/messages` 先持久化人类消息。
2. `/task` 继续由客户端走任务创建 API，不使用这个对话投递分支。
3. 普通消息进入 `ConversationCoordinator.dispatch`：精确提及优先，否则选择最先空闲的频道订阅 Agent。
4. 如果可用 Agent 已有该频道对话会话，输入进入该会话；否则以最近频道消息建立新会话。
5. Agent 产生文本时，协调器缓冲文本；该轮 settled 后以 Agent 身份写入一条频道消息。
6. Runtime 报错时，以 Agent 身份在频道给出简短失败说明，原始细节不外露。

对于本轮没有空闲 Agent 的情况，服务以系统消息说明“暂无空闲 Agent，消息已排队”，并在 Agent 可用时按人类消息创建时间 FIFO 投递。队列只在内存中保留；服务重启后未投递消息不自动重放，以避免重复回复。

## 验证

- 单元测试覆盖：无提及选择最先空闲 Agent、提及优先、忙碌 Agent 的队列行为、无空闲 Agent 的排队行为。
- 协调器测试覆盖：文本聚合为 Agent 频道消息、原始日志不进入频道、错误有简短 Agent 回复、下一轮复用同一会话。
- API 测试覆盖：普通频道消息会触发对话投递；任务消息与已有 `/task` 路径互不影响。
- 浏览器验收：发送普通消息后可以看到 Agent 名称和回复；`@agent` 指定的 Agent 回复；`/task` 仍创建任务而非对话消息。
