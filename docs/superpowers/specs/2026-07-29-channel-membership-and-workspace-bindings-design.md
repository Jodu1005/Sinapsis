# 频道成员与工作空间绑定设计

## 目标

将 Agent、频道和工作空间调整为彼此独立的领域实体：

- Agent 是全局可复用的身份与 Runtime 配置，不归属于某个工作空间。
- 频道是独立的协作和上下文边界，可以绑定零到多个工作空间。
- 工作空间是独立的本地执行目标，只在任务真正执行时参与调度。
- 普通频道的 Agent 成员由人类显式添加和移除。
- `summit` 自动包含所有 Agent，并继续作为唯一可清空全部频道上下文的特殊频道。

## 领域模型

```text
Agent ──< ChannelAgentMembership >── Channel
Workspace ──< ChannelWorkspaceBinding >── Channel
Task ──> Channel
Task ──> Workspace
```

### Agent

Agent 保存全局身份、Runtime、职责、能力标签、状态和并发限制。Agent 可以加入多个频道，也可以在不同工作空间的任务中工作。

Agent 的创建和全局删除只发生在独立的 Agent 管理界面。频道内只能选择已经创建的 Agent，不能顺便创建新 Agent。

### Channel

频道不归属于工作空间或代码仓。频道可以绑定零到多个工作空间，也可以拥有零到多个 Agent 成员。

频道新增稳定的 `systemKey`。普通频道的 `systemKey` 为空；特殊频道使用 `systemKey = "summit"`。特殊能力以 `systemKey` 判断，不依赖可修改的显示名称。

### Workspace

工作空间代表本地工作目录及其 Git 元数据。工作空间独立存在，可以被多个频道绑定。

每个频道默认最多绑定五个工作空间。上限由服务配置 `maxWorkspaceBindingsPerChannel` 提供，默认值为 `5`，服务端是最终约束执行者。

### Task

任务必须属于一个频道。代码任务执行前还必须明确绑定该频道允许使用的一个工作空间：

- 频道未绑定工作空间时，不能直接启动代码任务。
- 频道绑定一个工作空间时，界面自动预选。
- 频道绑定多个工作空间时，人类必须明确选择。
- 纯聊天不需要工作空间。

任务创建后记录明确的 `workspaceId`，运行时只能在该工作空间派生的隔离 worktree 中执行。

## Agent 成员规则

普通频道通过 `ChannelAgentMembership` 保存显式成员关系。只有人类控制面可以添加或移除成员，Agent Runtime 不获得成员管理命令。

`summit` 不保存成员关系，查询成员时动态返回所有 Agent。这样新 Agent 创建后会立即加入 `summit`，不依赖额外同步任务。

成员规则如下：

- 重复添加同一 Agent 为幂等成功。
- 普通频道只能 `@` 当前频道成员。
- `summit` 可以 `@` 任意现有 Agent。
- 普通消息只发布给当前频道成员，再由 Agent 按职责判断是否参与。
- 从频道移除 Agent 时，如果它正在该频道执行任务，请求被拒绝。
- 如果 Agent 只是在准备普通聊天回复，系统先取消该频道对话，再移除成员。
- Agent 退出频道后，历史消息继续使用发送时保存的显示名，不改写历史。

## 工作空间绑定规则

频道通过 `ChannelWorkspaceBinding` 保存工作空间关系。人类和 Agent 都可以发起创建或绑定工作空间的流程，但只有人类可以解绑或删除。

本原型的 Agent Runtime 不暴露绑定管理工具，因此首版所有实际绑定操作仍从人类控制面完成。未来为 Agent 增加绑定工具时，新增操作可复用同一服务，并保留删除权限隔离。

绑定规则如下：

- 重复绑定同一工作空间为幂等成功。
- 达到配置上限后，服务端拒绝新绑定。
- 从频道解绑只删除关系，不删除本地目录、Git worktree、证据或产物。
- 如果该频道仍有未完成任务使用工作空间，则拒绝解绑。
- 删除全局工作空间是独立的高风险操作，不与频道解绑共用接口。
- `summit` 同样遵守默认五个工作空间的上限。

## 频道交互

普通频道的右侧上下文增加两个区域。

“Agent 成员”展示当前成员，并提供搜索和添加已有 Agent 的入口。人类可以移除成员。

“工作空间”展示当前绑定，提供搜索和绑定已有工作空间的入口。界面显示当前数量与上限，例如 `3/5`。达到上限后禁用添加操作。

`summit` 的 Agent 成员区动态展示全部 Agent，并标记“自动同步”。该区域不提供添加或移除操作。工作空间绑定仍由人类管理，并遵守相同上限。

## 消息与任务流程

```text
人类发送普通消息
→ 发布给频道 Agent 成员
→ Agent 按职责评估是否参与
→ Selector 控制发言顺序
→ 后发言 Agent 读取频道已有回复并避免重复
→ 最多进行三轮 Agent 迭代
```

```text
人类创建代码任务
→ 选择频道绑定的工作空间
→ 选择或指定频道 Agent 成员
→ 创建任务并记录 channelId 与 workspaceId
→ Runtime 在该工作空间的任务 worktree 中执行
→ Agent 将清爽结果回复到原频道或 Thread
```

## 服务边界

### ChannelMembershipService

负责普通频道 Agent 的添加、移除和成员查询。对 `summit` 的成员修改请求直接拒绝。

### ChannelWorkspaceService

负责工作空间绑定、解绑、上限检查和未完成任务检查。

### ChannelPolicyService

根据 `systemKey` 和应用配置解析频道能力，包括自动全员、上下文清空和工作空间上限。

### ConversationCoordinator

只从频道成员集合中选择 Agent。直接提及不能绕过成员边界。`summit` 的成员集合由频道策略动态提供。

## API

```text
GET    /api/channels/:channelId/agents
POST   /api/channels/:channelId/agents
DELETE /api/channels/:channelId/agents/:agentId

GET    /api/channels/:channelId/workspaces
POST   /api/channels/:channelId/workspaces
DELETE /api/channels/:channelId/workspaces/:workspaceId
```

添加 Agent 的请求体只接受 `agentId`；添加工作空间的请求体只接受 `workspaceId`。

服务端返回明确的冲突错误，包括普通频道成员不满足、`summit` 不允许修改成员、工作空间达到上限、Agent 有活动任务，以及工作空间仍被未完成任务使用。

原型 0 运行在本地可信环境，成员和解绑 API 只由人类界面调用。后续引入认证时，请求上下文必须携带经过验证的 `actorType = "human"`，不能信任客户端自行提交的角色字段。

## 持久化与迁移

新增：

- `channels.system_key`
- `channel_agent_memberships(channel_id, agent_id, created_at)`
- `channel_workspace_bindings(channel_id, workspace_id, created_at)`
- `tasks.workspace_id`

迁移采用兼容阶段：

1. 为现有特殊频道写入 `system_key = "summit"`。
2. 将现有普通频道订阅迁移为显式 Agent 成员关系。
3. `summit` 的成员查询切换为动态全员，不再读取关系表。
4. 将现有频道关联的代码仓向上解析为工作空间，并写入频道工作空间绑定。
5. 旧 `agents.workspace_id` 和 `channels.repository_id` 暂时保留为兼容字段，新的业务读写不再依赖。
6. 数据和功能稳定后，再用独立迁移重建表并移除旧字段。

历史任务继续保留原始代码仓、worktree、证据和产物引用。迁移不删除本地文件。

## 测试

- 数据迁移：现有普通频道成员和工作空间关系完整迁移。
- 特殊频道：新建 Agent 无需同步即可出现在 `summit`。
- 成员权限：普通频道可由人类添加和移除；`summit` 拒绝修改。
- 路由边界：非成员不能被普通频道消息或 `@` 提及唤醒。
- 上限策略：默认第五个绑定成功，第六个被拒绝；修改配置后按新上限执行。
- 解绑保护：存在未完成任务时拒绝解绑工作空间。
- 成员保护：Agent 有活动频道任务时拒绝移除。
- 任务选择：零、一个、多个工作空间分别进入阻止、自动预选、显式选择流程。
- 历史保留：成员移除和工作空间解绑不删除历史消息、worktree、证据或产物。
- 界面：普通频道可管理成员；`summit` 显示自动全员且没有成员修改按钮。

## 本期范围

本期实现全局 Agent、独立频道、显式成员、频道工作空间绑定、默认上限和 `summit` 自动全员。

不在本期实现 Agent 自主邀请、成员审批流、复杂角色权限、远程多用户认证，以及 Agent 自主删除任何实体。
