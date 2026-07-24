import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TaskDetailView, TaskView } from '../domain/workspace-view'
import { TaskDetailPanel } from './TaskDetailPanel'

const task: TaskView = {
  id: 'task-1', repositoryId: 'repo-1', channelId: 'channel-1', directAgentId: null, title: '补齐移动端抽屉', description: '修复窄屏下的导航遮挡。',
  acceptanceCriteria: '390px 可操作且没有遮挡。', labels: ['frontend'], status: 'in_review', queuedAt: '2026-07-25T08:00:00.000Z', attemptCount: 1,
  maxRetries: 2, timeoutMs: 3_600_000, leaseTtlMs: null, branchName: 'task/task-1', worktreePath: '/tmp/task-1', createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
}
const details: TaskDetailView = { task, sessions: [], leases: [], inputs: [], decisions: [], artifacts: [{ id: 'artifact-1', taskId: 'task-1', kind: 'test-results', createdAt: '2026-07-25T08:01:00.000Z' }], events: [] }

describe('TaskDetailPanel', () => {
  it('shows overview, input queue, evidence and review, while acceptance explicitly does not merge', async () => {
    const onReview = vi.fn().mockResolvedValue({ ...task, status: 'accepted' })
    render(<TaskDetailPanel details={details} onQueueInput={vi.fn()} onReview={onReview} onReadArtifact={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '概览' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '输入队列' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '证据' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '审查' })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: '接受验收' }))
    expect(onReview).toHaveBeenCalledWith('accept')
    expect(await screen.findByText('验收已通过，尚未合并')).toBeInTheDocument()
    expect(screen.queryByText('已合并')).not.toBeInTheDocument()
  })

  it('does not retain an accepted notice after selecting another task', async () => {
    const onReview = vi.fn().mockResolvedValue({ ...task, status: 'accepted' })
    const view = render(<TaskDetailPanel details={details} onQueueInput={vi.fn()} onReview={onReview} onReadArtifact={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '接受验收' }))
    expect(await screen.findByText('验收已通过，尚未合并')).toBeInTheDocument()

    view.rerender(<TaskDetailPanel details={{ ...details, task: { ...task, id: 'task-2', title: '第二个待验收任务' } }} onQueueInput={vi.fn()} onReview={vi.fn()} onReadArtifact={vi.fn()} />)

    expect(screen.getByRole('button', { name: '接受验收' })).toBeEnabled()
    expect(screen.queryByText('验收已通过，尚未合并')).not.toBeInTheDocument()
  })
})
