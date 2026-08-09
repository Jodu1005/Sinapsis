import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView, TaskView } from '../domain/workspace-view'
import { TaskBoard } from './TaskBoard'

const agents: AgentView[] = [{
  id: 'agent-1', identity: 'Build', mentionName: 'build', runtime: 'opencode' as const, status: 'idle' as const,
  capabilityTags: [], maxConcurrentTasks: 1, command: 'opencode', args: ['run'], model: '', env: [],
  createdAt: '2026-08-06T08:00:00.000Z', updatedAt: '2026-08-06T08:00:00.000Z',
}]

const baseTask: TaskView = {
  id: 'task-1',
  workspaceId: 'workspace-1',
  repositoryId: 'repo-1',
  channelId: 'channel-1',
  directAgentId: null,
  title: '补齐任务看板',
  description: '实现泳道拖动。',
  acceptanceCriteria: '状态按规则流转。',
  labels: ['frontend'],
  status: 'backlog',
  queuedAt: '2026-08-06T08:00:00.000Z',
  attemptCount: 0,
  maxRetries: 2,
  timeoutMs: 900000,
  leaseTtlMs: null,
  branchName: null,
  worktreePath: null,
  createdAt: '2026-08-06T08:00:00.000Z',
  updatedAt: '2026-08-06T08:00:00.000Z',
}

describe('TaskBoard', () => {
  it('moves a backlog task to todo by dragging it into the todo lane', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    render(<TaskBoard tasks={[baseTask]} agents={agents} selectedTaskId={null} onSelect={vi.fn()} onMove={onMove} />)

    dragTaskToLane('补齐任务看板', '待办任务')

    await waitFor(() => expect(onMove).toHaveBeenCalledWith('task-1', 'todo', undefined))
  })

  it('requires feedback before returning a review task to todo', async () => {
    const onMove = vi.fn().mockResolvedValue(undefined)
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('').mockReturnValueOnce('补充回归测试。')
    render(<TaskBoard tasks={[{ ...baseTask, status: 'in_review' }]} agents={agents} selectedTaskId={null} onSelect={vi.fn()} onMove={onMove} />)

    dragTaskToLane('补齐任务看板', '待办任务')
    expect(await screen.findByText('审核任务退回待办前需要填写修改意见。')).toBeInTheDocument()
    expect(onMove).not.toHaveBeenCalled()

    dragTaskToLane('补齐任务看板', '待办任务')
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('task-1', 'todo', '补充回归测试。'))
    prompt.mockRestore()
  })

  it('shows the Agent that most recently handled a task', () => {
    render(<TaskBoard tasks={[{ ...baseTask, lastAgentId: 'agent-1', status: 'in_review' }]} agents={agents} selectedTaskId={null} onSelect={vi.fn()} onMove={vi.fn()} />)

    expect(screen.getByText('@Build')).toBeInTheDocument()
  })

  it('shows when the task was created on its card', () => {
    render(<TaskBoard tasks={[baseTask]} agents={agents} selectedTaskId={null} onSelect={vi.fn()} onMove={vi.fn()} />)

    expect(document.querySelector('time.task-card-time')).toHaveTextContent('创建于')
    expect(document.querySelector('time.task-card-time')).toHaveAttribute('dateTime', baseTask.createdAt)
  })
})

function dragTaskToLane(taskName: string, laneName: string): void {
  const dataTransfer = {
    effectAllowed: '',
    setData: vi.fn(),
    getData: vi.fn(),
  }
  fireEvent.dragStart(screen.getByRole('button', { name: new RegExp(taskName) }), { dataTransfer })
  fireEvent.drop(screen.getByRole('region', { name: laneName }), { dataTransfer })
}
