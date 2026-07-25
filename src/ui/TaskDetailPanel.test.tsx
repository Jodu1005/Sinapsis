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
const details: TaskDetailView = { task, sessions: [], leases: [], inputs: [], decisions: [], artifacts: [
  { id: 'artifact-commit', taskId: 'task-1', kind: 'review-commit', createdAt: '2026-07-25T08:01:00.000Z' },
  { id: 'artifact-files', taskId: 'task-1', kind: 'review-changed-files', createdAt: '2026-07-25T08:01:00.000Z' },
  { id: 'artifact-stderr', taskId: 'task-1', kind: 'review-controlled-stderr', createdAt: '2026-07-25T08:01:00.000Z' },
  { id: 'artifact-diff', taskId: 'task-1', kind: 'review-diff-summary', createdAt: '2026-07-25T08:01:00.000Z' },
  { id: 'artifact-log', taskId: 'task-1', kind: 'runtime-stderr', createdAt: '2026-07-25T08:01:00.000Z' },
], events: [] }

describe('TaskDetailPanel', () => {
  it('shows review boundaries without claiming an OS sandbox or automatic repository actions', async () => {
    const onReview = vi.fn().mockResolvedValue({ ...task, status: 'accepted' })
    const onReadArtifact = vi.fn((artifactId: string) => Promise.resolve({
      'artifact-commit': 'abc123 Implement mobile drawer',
      'artifact-files': 'M src/ui/WorkspaceShell.tsx',
      'artifact-stderr': 'warning: optional dependency missing\\n',
      'artifact-diff': '2 files changed, 34 insertions(+)',
      'artifact-log': 'raw runtime output',
    }[artifactId] ?? ''))
    render(<TaskDetailPanel details={details} onQueueInput={vi.fn()} onReview={onReview} onReadArtifact={onReadArtifact} />)

    expect(screen.getByRole('heading', { name: '概览' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '输入队列' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '证据' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '审查' })).toBeInTheDocument()
    expect(screen.getByText(/此版本没有 OS 级沙箱/)).toBeInTheDocument()
    expect(screen.getByText(/工作树隔离是约定而非权限边界/)).toBeInTheDocument()
    expect(screen.getByText(/运行未经信任的本地 CLI 前，请先确认信任它/)).toBeInTheDocument()
    expect(screen.getByText(/内置 API 不会自动 push 或 merge/)).toBeInTheDocument()
    expect(await screen.findByText('abc123 Implement mobile drawer')).toBeInTheDocument()
    expect(screen.getByText('M src/ui/WorkspaceShell.tsx')).toBeInTheDocument()
    expect(screen.getByText('受控进程 stderr（非测试结论）')).toBeInTheDocument()
    expect(screen.getByText('warning: optional dependency missing\\n')).toBeInTheDocument()
    expect(screen.getByText('2 files changed, 34 insertions(+)')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '原始运行日志' })).toBeInTheDocument()
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

  it('clears queued input feedback when selecting another task', async () => {
    const runningDetails = { ...details, task: { ...task, status: 'running' as const } }
    const view = render(<TaskDetailPanel details={runningDetails} onQueueInput={vi.fn().mockResolvedValue(undefined)} onReview={vi.fn()} onReadArtifact={vi.fn().mockResolvedValue('')} />)
    const user = userEvent.setup()

    await user.type(screen.getByRole('textbox', { name: '发送任务输入' }), '请补一组回归测试')
    await user.click(screen.getByRole('button', { name: '发送任务输入' }))
    expect(await screen.findByText('已排队，当前安全步骤结束后送达。')).toBeInTheDocument()

    view.rerender(<TaskDetailPanel details={{ ...runningDetails, task: { ...runningDetails.task, id: 'task-2', title: '另一个运行任务' } }} onQueueInput={vi.fn()} onReview={vi.fn()} onReadArtifact={vi.fn().mockResolvedValue('')} />)

    expect(screen.queryByText('已排队，当前安全步骤结束后送达。')).not.toBeInTheDocument()
  })

  it('renders streamed Agent text directly in the task detail panel', () => {
    const runningDetails = {
      ...details,
      task: { ...task, status: 'running' as const },
      events: [
        { id: 'event-1', taskId: task.id, type: 'runtime.text', payload: { text: '正在检查测试配置。' }, createdAt: '2026-07-25T08:03:00.000Z' },
        { id: 'event-2', taskId: task.id, type: 'runtime.text', payload: { text: '发现一处失败。' }, createdAt: '2026-07-25T08:04:00.000Z' },
      ],
    }

    render(<TaskDetailPanel details={runningDetails} onQueueInput={vi.fn()} onReview={vi.fn()} onReadArtifact={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Agent 输出' })).toBeInTheDocument()
    expect(screen.getByLabelText('Agent 实时输出')).toHaveTextContent('正在检查测试配置。发现一处失败。')
  })

  it('allows a human-handled task to be requeued instead of incorrectly accepting it', async () => {
    const onRequeue = vi.fn().mockResolvedValue(undefined)
    render(<TaskDetailPanel details={{ ...details, task: { ...task, status: 'needs_human' } }} onQueueInput={vi.fn()} onReview={vi.fn()} onRequeue={onRequeue} onReadArtifact={vi.fn()} />)

    expect(screen.getByRole('button', { name: '接受验收' })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: '重新执行' }))
    expect(onRequeue).toHaveBeenCalledOnce()
  })
})
