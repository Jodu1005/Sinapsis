import { DomainError, type Task } from '../domain/task'
import type { WorkspaceRepositories } from '../ports/repositories'
import { ChannelMessageService } from './channel-message-service'

export interface ReturnedTaskResumer {
  resumeReturnedTask(taskId: string): Promise<void>
}

export class TaskReviewService {
  constructor(
    private readonly repositories: WorkspaceRepositories,
    private readonly resumer?: ReturnedTaskResumer,
    private readonly messages = new ChannelMessageService(repositories),
  ) {}

  async review(taskId: string, action: 'accept' | 'return', message: string): Promise<Task> {
    const task = this.repositories.getTask(taskId)
    if (!task) throw new DomainError(`Task ${taskId} does not exist.`)
    if (task.status !== 'in_review') throw new DomainError('Only tasks awaiting review can be accepted or returned.')
    if (action === 'accept') {
      const accepted = this.repositories.inTransaction((unitOfWork) => {
        unitOfWork.createReviewDecision(taskId, 'accept', message)
        const next = unitOfWork.transitionTask(taskId, 'accepted', '人工验收通过')
        unitOfWork.createMessage({ channelId: task.channelId, threadRootMessageId: task.threadRootMessageId, taskId, senderType: 'system', authorName: 'Sinapsis', body: '人工已验收任务；合并仍需独立人工流程。' })
        return next
      })
      return accepted
    }
    if (!this.resumer) throw new DomainError('Task return requires an execution coordinator.')
    this.repositories.inTransaction((unitOfWork) => {
      unitOfWork.createReviewDecision(taskId, 'return', message)
      const next = unitOfWork.transitionTask(taskId, 'returned', '人工退回修改')
      unitOfWork.createTaskInput(taskId, message)
      unitOfWork.createMessage({ channelId: task.channelId, threadRootMessageId: task.threadRootMessageId, taskId, senderType: 'system', authorName: 'Sinapsis', body: '人工已退回任务，正在恢复原会话。' })
      return next
    })
    try {
      await this.resumer.resumeReturnedTask(taskId)
    } catch (error) {
      this.repositories.inTransaction((unitOfWork) => {
        const current = this.repositories.getTask(taskId)
        if (current?.status !== 'returned') return
        unitOfWork.transitionTask(taskId, 'needs_human', '无法恢复原 Runtime 会话')
        unitOfWork.createMessage({
          channelId: task.channelId, threadRootMessageId: task.threadRootMessageId, taskId, senderType: 'system', authorName: 'Sinapsis',
          body: '无法恢复原 Runtime 会话，任务等待人工处理。',
        })
      })
      throw error
    }
    const resumed = this.repositories.getTask(taskId)
    if (!resumed) throw new DomainError(`Task ${taskId} does not exist.`)
    return resumed
  }

  merge(_taskId: string): never {
    throw new DomainError('第一版只记录验收，合并需要独立人工流程。')
  }
}
