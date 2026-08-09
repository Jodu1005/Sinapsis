import type { Agent } from '../domain/agent'
import type { Task } from '../domain/task'
import type { WorkspaceRepositories } from '../ports/repositories'
import { ChannelMessageService } from './channel-message-service'
import type { ConversationSessionService } from './conversation-session-service'

type ConversationSessions = Pick<ConversationSessionService, 'invoke'>

export interface BacklogAnalysisServiceOptions {
  repositories: WorkspaceRepositories
  messages?: ChannelMessageService
  sessions: ConversationSessions
}

export class BacklogAnalysisService {
  private readonly messages: ChannelMessageService

  constructor(private readonly options: BacklogAnalysisServiceOptions) {
    this.messages = options.messages ?? new ChannelMessageService(options.repositories)
  }

  start(task: Task): void {
    void this.analyze(task).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '未知错误'
      this.messages.postMilestone(
        task.channelId,
        task.id,
        `积压分析暂未完成：${message}`,
        task.threadRootMessageId,
      )
    })
  }

  private async analyze(createdTask: Task): Promise<void> {
    const task = this.options.repositories.getTask(createdTask.id)
    if (!task || task.status !== 'backlog') return
    const agent = this.selectAgent(task)
    if (!agent) {
      this.messages.postMilestone(task.channelId, task.id, '暂时没有可用 Agent，任务将保留在积压中等待分析。', task.threadRootMessageId)
      return
    }
    const rootMessageId = task.threadRootMessageId
    if (!rootMessageId) throw new Error('任务缺少讨论根消息。')

    const result = await this.options.sessions.invoke({
      channelId: task.channelId,
      threadRootMessageId: rootMessageId,
      currentMessageId: rootMessageId,
      agent,
      context: `你正在对一个刚创建的积压任务做预分析。不要实现代码、不要修改文件、不要承诺已经完成工作。请识别目标、边界、风险、待确认问题，并给出进入待办前建议补齐的信息。`,
      initialMessage: analysisRequest(task),
      executionPolicy: 'read-only-no-tools',
    })
    const body = result.text.trim() || '我已完成初步分析，但暂时没有可展示的结论。'
    this.messages.postAgent(task.channelId, task.id, agent.id, agent.identity, body, rootMessageId)
  }

  private selectAgent(task: Task): Agent | undefined {
    const memberIds = new Set(this.options.repositories.getChannelAgentIds(task.channelId))
    const candidates = this.options.repositories.listAgents().filter((agent) => memberIds.has(agent.id) && agent.status !== 'offline')
    if (task.directAgentId) return candidates.find((agent) => agent.id === task.directAgentId)
    return candidates.find((agent) => agent.status === 'idle' && task.labels.some((label) => agent.capabilityTags.includes(label)))
      ?? candidates.find((agent) => agent.status === 'idle')
      ?? candidates[0]
  }
}

function analysisRequest(task: Task): string {
  const labels = task.labels.length > 0 ? task.labels.join('、') : '未标注'
  return `请分析这项积压任务，并以 Markdown 写一条供人类讨论的简洁评论。\n\n## 任务\n${task.title}\n\n## 说明\n${task.description}\n\n## 完成定义\n${task.acceptanceCriteria}\n\n## 标签\n${labels}\n\n请包含：\n- 你对目标与范围的理解\n- 主要风险或依赖\n- 进入待办前仍需人类确认的问题\n\n只做分析，不要开始执行。`
}
