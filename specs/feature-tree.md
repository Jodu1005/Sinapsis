# 功能树：本机 Agent 工作空间

状态：第一版已实现，本机验证完成
对应设计：[本机 Agent 工作空间设计](../docs/superpowers/specs/2026-07-24-local-agent-workspace-design.md)

## 使用规则

- 这是当前产品范围的唯一功能索引。
- 第一版以“一个人在本机协调多个编码 Agent”为边界。
- 第一版的主界面是频道交流；任务是独立视图，不是常驻看板。
- 频道多 Agent 发布订阅、远程协作和云端同步均不提前实现。

## 功能层级

```text
本机 Agent 工作空间
|
|-- F0 工作空间与代码仓
|   |-- F0.1 创建和选择工作空间
|   |-- F0.2 添加本地 Git 代码仓
|   `-- F0.3 保存仓库路径、默认目标分支与 Git 基础状态
|
|-- F1 频道交流界面
|   |-- F1.1 按代码仓组织频道
|   |-- F1.2 显示频道消息、线程与 Agent 状态
|   |-- F1.3 发送普通消息
|   |-- F1.4 发送 @Agent 定向消息
|   `-- F1.5 多 Agent Conversation Turn
|       |-- 普通、单提及、多提及与 @all 四种路由模式
|       |-- 筛选、判断、排队、准备、交接与最终回复状态
|       |-- Thread 隔离的持久化 Session 与重启恢复
|       |-- Turn 级租约 CAS、Invocation 结果重放与公开消息幂等提交
|       `-- 结构化 Handoff 路由与仅公开文本回复
|
|-- F2 Agent 与 Runtime
|   |-- F2.1 手动创建 Agent 身份
|   |-- F2.2 配置能力标签与单任务并发
|   |-- F2.3 检测 OpenCode 与 Pi Agent
|   |-- F2.4 应用 Runtime 预设并允许覆盖命令配置
|   `-- F2.5 显示空闲、忙碌、错误、离线状态
|
|-- F3 任务输入与分类
|   |-- F3.1 用标题、描述、验收标准创建任务
|   |-- F3.2 绑定当前代码仓
|   |-- F3.3 自动推断能力标签并允许修改
|   `-- F3.4 写入严格 FIFO 等待队列
|
|-- F4 调度与可靠性
|   |-- F4.1 @Agent 直接领取
|   |-- F4.2 匹配的空闲 Agent FIFO 自动领取
|   |-- F4.3 原子领取与独占租约
|   |-- F4.4 心跳、超时与有限重试
|   `-- F4.5 超过重试上限后等待人工处理
|
|-- F5 隔离执行与会话
|   |-- F5.1 为任务创建分支和 Git worktree
|   |-- F5.2 启动受管 OpenCode 或 Pi 会话
|   |-- F5.3 流式接收 Runtime 事件
|   |-- F5.4 将 @Agent 消息写入当前任务输入队列
|   |-- F5.5 停止、超时或恢复会话
|   `-- F5.6 在任务分支创建提交
|
|-- F6 任务详情与人工验收
|   |-- F6.1 仅在频道发布关键进展与总结
|   |-- F6.2 展示完整日志、测试输出、diff 与提交
|   |-- F6.3 进入等待输入或待人工验收
|   |-- F6.4 接受、退回与人工处理
|   `-- F6.5 将合并与推送保留为独立确认动作
|
|-- F7 Dream Memory 与上下文
|   |-- F7.1 可配置定时 Dream 与手动单频道/全部频道运行
|   |-- F7.2 独立维护队列、按频道隔离和 completed-only 水位
|   |-- F7.3 Candidate 来源追溯、受本地人类 capability 保护的 scope/content 编辑、接受与忽略
|   |-- F7.4 Global Memory、Channel Memory 与 Thread Summary 分层注入
|   |-- F7.5 Memory 编辑即时生效、软归档及来源审计保留
|   |-- F7.6 Dream Center 的待审核 badge、Run 与来源详情
|   `-- F7.7 重启失败恢复、同水位重跑、非法 Candidate 隔离审计
|
`-- F8 后续能力
    |-- F8.1 多 Agent 频道发布订阅
    |-- F8.2 Agent 私聊、搜索、附件与未读通知
    |-- F8.3 任务优先级、插队和多并发席位
    |-- F8.4 多机 Worker、账号与云端协调
    `-- F8.5 Runtime / Adapter SDK
```

## 第一版交付切片

1. F0 与 F2：用户能创建本机工作空间、添加代码仓，并配置可检测的 OpenCode 或 Pi Agent。
2. F1 与 F3：用户能在代码仓频道中交流，并通过紧凑任务面板提交任务。
3. F4 与 F5：匹配的空闲 Agent 能独占领取 FIFO 任务，在独立 worktree 中运行并提交改动。
4. F6：用户能查看任务的完整证据，作出接受或退回决定；接受不会自动合并。

## 第一版验收映射

| 用户结果 | 所需节点 | 验收证据 |
| --- | --- | --- |
| 在一个工作空间管理多个代码仓 | F0 | 代码仓分组、保存的工作目录与目标分支 |
| 在频道中看到人与 Agent 的协作 | F1、F5.3、F6.1 | 消息、@Agent 输入、关键进展与任务链接 |
| 提交任务后由正确的空闲 Agent 执行 | F2、F3、F4 | 标签、FIFO 顺序、独占领取事件 |
| 多任务不污染同一仓库 | F5.1 | 任务分支与独立 worktree 路径 |
| 对正在运行的 Agent 中途纠偏 | F1.4、F5.4 | 消息进入正确任务会话且被记录 |
| 可审查且不自动合并 | F6 | diff、测试输出、提交、人工决定与独立合并动作 |
| 从公开对话沉淀可控长期上下文 | F7 | Dream Run、水位、Candidate 来源审核、分层冷启动 Prompt 与软归档 |

## 不变量

- 一个任务在任一时刻只能有一个活跃领取者和一个有效租约。
- 一个 Agent 在第一版同时只能执行一个任务。
- 同一代码仓的并行任务必须使用不同 worktree。
- 任务、会话、Agent 状态与频道消息分别保存，不能用文案推断状态。
- Agent 只能在所属工作空间和已绑定代码仓的 worktree 中执行。
- Runtime 失败不得静默吞掉任务；重试、人工处理和状态变化必须留下事件。
- 接受不等于合并；`git push`、合并和仓外副作用必须有独立人工确认。
- Conversation Turn 的 Runtime 原始 Artifact、私有 Prompt 和结构化路由不得进入频道或公开 Turn 详情。
- Dream Candidate 在人工接受前不得进入任何 Agent Prompt；Runtime Artifact、敏感内容和无有效来源 Candidate 不得成为可接受 Memory。
- Memory 审核控制面必须验证服务进程生成的人类 capability；凭证不得进入 Agent Runtime 环境、Prompt、消息、数据库或 Artifact。
- Dream 成功水位只由 `completed` Run 推进；失败与重启恢复必须保留固定来源集合，使同一输入可重跑。
- Agent 冷启动上下文按 Global Memory、Channel Memory、Thread Summary、近期公开消息的层级注入；Global 跨频道，Channel 只作用于目标频道，Thread Summary 只作用于对应 Thread。
- Memory 删除是软归档，不物理删除 Candidate、来源或审核历史。

## 第一版验证状态

- F0-F6 已实现并由服务端、前端或完整集成测试覆盖。
- 本机流程测试验证：FIFO 领取、同仓不同 worktree、忙碌 Agent 输入、任务分支提交、人工验收与不自动合并。
- F1.5 验证普通筛选与去重、第二轮 Handoff、持久化会话恢复、resume 失败后的 timeline/Thread 冷启动、单提及与多提及并行失败隔离、Turn 级原子领取、取消发布栅栏和 Artifact 隔离；migration 18 归属 Conversation Turn。
- F7 已验证手动频道隔离、独立维护队列与同水位幂等、Candidate 审核门、Global/Channel/Thread 分层 Prompt、Memory 编辑与软归档、SQLite 重建持久化、敏感内容和 Artifact 隔离，以及 `service_restarted` 重启恢复；Dream 数据从 migration 19 开始，migration 24 增加无有效来源 Candidate 的恢复审计。
- 浏览器检查验证：创建工作空间与仓库、添加 Agent、频道消息、任务输入、证据读取、接受任务，以及 700px 窄屏下抽屉关闭时消息输入可用。
- F8 保持后续能力，不属于当前交付。
