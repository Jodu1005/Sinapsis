# 全局频道与 Thread 设计

## 目标

将 Sinapsis 从“代码仓拥有频道”调整为 Slack 式协作模型：频道是全局唯一的聊天空间；工作空间仅提供 Agent 与任务的本地执行上下文；Thread 收纳围绕某条频道消息的讨论与任务执行记录。

## 领域关系

```text
Channel --< Message
Message(root) --< Message(reply)
Task -> Channel + Workspace + Repository + Thread root
Workspace --< Repository
Workspace --< Agent
Channel --< Agent subscription
```

`Channel` 使用规范化名称（trim、小写）作为全局唯一键。为保持 SQLite 外键和已有历史兼容，表内暂时保留一个不可见的 `repositoryId` 作为技术归属；产品与 API 语义中频道是全局的，不按工作空间过滤。`Task` 保持 `repositoryId`（由此确定执行工作空间），并新增 `threadRootMessageId`；创建时验证代码仓属于目标工作空间，且频道处于活跃状态。

## 频道与历史迁移

数据库迁移创建全局 `channels` 表，并把原表的频道完整复制到新表：最早创建的同名频道保留原名称，其他同名频道改为 `legacy-<workspace-slug>-<name>` 并标记归档。任务、消息继续引用各自原频道 ID，不丢失历史。归档频道不会出现在主导航，也不能继续发布消息。

新建工作空间或代码仓不会自动创建 `general`。初始化时只有一个全局 `#general`；若数据库没有可用频道，创建它。

## Thread

`messages.thread_root_id` 为 null 时是频道时间线根消息；非 null 时必须引用同频道的一条根消息。根消息记录 `replyCount` 与 `lastReplyAt` 派生摘要，便于主时间线显示“n 条回复”。Thread 侧栏按根消息和回复的创建时间展示。

频道时间线只展示根消息。Thread 内发送的消息传入根消息 ID，Agent 回复与任务生命周期消息继承该 Thread 根。普通频道对话没有 Thread 时沿用频道会话；Thread 对话的 runtime session key 为 `channelId:threadRootMessageId:agentId`，上下文优先使用当前 Thread，再补少量频道根消息。

## UI 与任务

左侧只显示全局频道。点击频道不再切换工作空间。频道右侧显示该频道中的任务，并按执行工作空间分组。创建任务时，人必须选执行工作空间和该工作空间的代码仓；任务创建后自动建立一条根消息，并让运行过程在该 Thread 下发布。

频道时间线的消息带“回复”入口；选择后打开右侧 Thread 面板，输入框切换为“回复 Thread”。无 Thread 时，输入框发到频道主时间线。

## Agent 参与规则

频道订阅表决定可被提及的 Agent。第一阶段在 Agent 创建后自动订阅所有活跃频道，频道创建后自动订阅现有 Agent，保证现有本地工作流不中断；成员管理 UI 是下一阶段能力。`@Agent 名称` 只路由到当前频道的订阅 Agent；没有 @ 时由当前频道空闲订阅 Agent 的轮询顺序回复。

## 验收标准

- 数据库中不能存在两个活跃的同名频道，且新工作空间不会生成 `general`。
- `#general` 主时间线可跨工作空间聊天；工作空间选择只发生在创建任务时。
- 一个根消息的回复不出现在频道主时间线，且 Agent 回复保持在该 Thread。
- 任务创建必须绑定频道、工作空间、代码仓和 Thread 根；任务消息在对应 Thread 中可见。
- 既有频道、消息与任务均可读取；迁移对重复旧频道采用只读归档而非删除。
