import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TaskDetailView, TaskView } from '../domain/workspace-view'
import { TaskDetailDialog } from './TaskDetailDialog'

const task: TaskView = {
  id: 'task-1', workspaceId: 'workspace-1', repositoryId: 'repository-1', channelId: 'channel-1', directAgentId: null,
  title: '整理调研报告', description: '整理报告', acceptanceCriteria: '可阅读', labels: [], status: 'completed', queuedAt: '2026-08-06T08:00:00.000Z',
  attemptCount: 1, maxRetries: 2, timeoutMs: 3_600_000, leaseTtlMs: null, branchName: null, worktreePath: null,
  createdAt: '2026-08-06T08:00:00.000Z', updatedAt: '2026-08-06T08:00:00.000Z',
}

const details: TaskDetailView = {
  task, sessions: [{ id: 'session-1', taskId: task.id, agentId: 'agent-1', runtimeSessionId: 'runtime-1', status: 'completed', createdAt: '2026-08-06T08:00:00.000Z', updatedAt: '2026-08-06T08:01:00.000Z' }], leases: [], inputs: [], decisions: [], artifacts: [],
  events: [{ id: 'event-1', taskId: task.id, type: 'runtime.text', payload: { text: '# 调研结论\n\n- **已完成**\n- 使用 `pi --mode rpc`\n\n```ts\nrun()\n```' }, createdAt: '2026-08-06T08:01:00.000Z' }],
}

describe('TaskDetailDialog', () => {
  it('renders the Agent reply as Markdown inside one reading surface', () => {
    render(<TaskDetailDialog task={task} details={details} agents={[{
      id: 'agent-1', identity: 'Build', mentionName: 'build', runtime: 'opencode', status: 'idle', capabilityTags: [], maxConcurrentTasks: 1,
      command: 'opencode', args: ['run'], model: '', env: [], createdAt: '2026-08-06T08:00:00.000Z', updatedAt: '2026-08-06T08:00:00.000Z',
    }]} error={null} onClose={vi.fn()} />)

    const reply = screen.getByLabelText('Agent 回复内容')
    expect(reply).toHaveClass('agent-reply-surface')
    expect(screen.getByRole('heading', { name: '调研结论' })).toBeInTheDocument()
    expect(screen.getByText('已完成').tagName).toBe('STRONG')
    expect(screen.getByText('pi --mode rpc')).toHaveProperty('tagName', 'CODE')
    expect(screen.getByText('run()').closest('pre')).toBeInTheDocument()
    expect(screen.getByText('处理 Agent · @Build · opencode')).toBeInTheDocument()
    expect(screen.getByText(/Build agent 回复/)).toHaveAttribute('dateTime', '2026-08-06T08:01:00.000Z')
    expect(document.querySelector('.task-detail-timestamps time:first-child')).toHaveTextContent('创建')
    expect(document.querySelector('.task-detail-timestamps time:first-child')).toHaveAttribute('dateTime', task.createdAt)
    expect(document.querySelector('.task-detail-timestamps time:last-child')).toHaveTextContent('更新')
    expect(document.querySelector('.task-detail-timestamps time:last-child')).toHaveAttribute('dateTime', task.updatedAt)
  })

  it('separates follow-up Agent replies instead of gluing them together', () => {
    const followUpDetails: TaskDetailView = {
      ...details,
      sessions: [{ ...details.sessions[0]!, status: 'running' }],
      inputs: [{ id: 'input-1', taskId: task.id, body: '请返工调整。', createdAt: '2026-08-06T08:02:00.000Z', consumedAt: '2026-08-06T08:03:00.000Z' }],
      events: [
        { id: 'event-1', taskId: task.id, type: 'runtime.text', payload: { text: '第一次回答。' }, createdAt: '2026-08-06T08:01:00.000Z' },
        { id: 'event-2', taskId: task.id, type: 'runtime.text', payload: { text: '第二次回答。' }, createdAt: '2026-08-06T08:04:00.000Z' },
      ],
    }
    render(<TaskDetailDialog task={task} details={followUpDetails} agents={[]} error={null} onClose={vi.fn()} />)

    const replies = screen.getAllByLabelText('Agent 回复内容')
    expect(replies).toHaveLength(2)
    expect(replies[0]).toHaveTextContent('第一次回答。')
    expect(replies[0]).not.toHaveTextContent('第二次回答。')
    expect(replies[1]).toHaveTextContent('第二次回答。')
    expect(replies[1]).toHaveTextContent('Agent 回复')
  })

  it('opens an ACP process view without replacing the final Agent reply', async () => {
    const user = userEvent.setup()
    const processDetails = {
      ...details,
      artifacts: [{ id: 'artifact-1', taskId: task.id, kind: 'runtime-jsonl', createdAt: '2026-08-06T08:01:00.000Z' }],
    }
    render(<TaskDetailDialog task={task} details={processDetails} agents={[]} error={null} onReadArtifact={vi.fn().mockResolvedValue([
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在检查配置。' } } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '请稍候。' } } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read package.json' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } } }),
    ].join('\n'))} onClose={vi.fn()} />)

    await user.click(screen.getByRole('tab', { name: '执行过程' }))
    expect(await screen.findByLabelText('OpenCode 执行过程')).toHaveTextContent('正在检查配置。请稍候。')
    expect(screen.getByLabelText('OpenCode 执行过程')).toHaveTextContent('Read package.json')
    await user.click(screen.getByRole('tab', { name: '回复' }))
    expect(screen.getByLabelText('Agent 回复内容')).toHaveTextContent('调研结论')
  })

  it('opens a CLI OpenCode process view instead of staying in a loading state', async () => {
    const user = userEvent.setup()
    const processDetails = {
      ...details,
      artifacts: [{ id: 'artifact-cli', taskId: task.id, kind: 'runtime-jsonl', createdAt: '2026-08-06T08:01:00.000Z' }],
    }
    render(<TaskDetailDialog task={task} details={processDetails} agents={[]} error={null} onReadArtifact={vi.fn().mockResolvedValue([
      JSON.stringify({ type: 'step_start', timestamp: 1 }),
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls -la' }, output: 'README.md' } } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: '已完成检查。' } }),
    ].join('\n'))} onClose={vi.fn()} />)

    await user.click(screen.getByRole('tab', { name: '执行过程' }))
    const process = await screen.findByLabelText('OpenCode 执行过程')
    expect(process).not.toHaveTextContent('正在读取 OpenCode 过程')
    expect(process).toHaveTextContent('bash · ls -la')
    expect(process).toHaveTextContent('README.md')
    expect(process).toHaveTextContent('已完成检查。')
  })

  it('shows backlog analysis as a comment thread and lets a human respond', async () => {
    const onComment = vi.fn().mockResolvedValue(undefined)
    const onRetryAnalysis = vi.fn().mockResolvedValue(undefined)
    const backlogTask = { ...task, status: 'backlog' as const }
    const backlogDetails = {
      ...details,
      task: backlogTask,
      comments: [{
        id: 'comment-1', channelId: 'channel-1', threadRootMessageId: null, taskId: 'task-1', senderType: 'agent' as const, senderId: 'agent-1', authorName: 'Build',
        body: '## 预分析\n\n- 先确认接口边界。', createdAt: '2026-08-06T08:01:00.000Z', updatedAt: '2026-08-06T08:01:00.000Z', deletedAt: null,
      }],
    }
    const user = userEvent.setup()
    render(<TaskDetailDialog task={backlogTask} details={backlogDetails} agents={[{
      id: 'agent-1', identity: 'Build', mentionName: 'build', runtime: 'opencode', status: 'idle', capabilityTags: [], maxConcurrentTasks: 1,
      command: 'opencode', args: ['run'], model: '', env: [], createdAt: '2026-08-06T08:00:00.000Z', updatedAt: '2026-08-06T08:00:00.000Z',
    }]} error={null} onComment={onComment} onRetryAnalysis={onRetryAnalysis} onClose={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '积压分析' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '预分析' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '同意分析' }))
    expect(onComment).toHaveBeenCalledWith('我同意这份积压分析，可以继续完善并准备进入待办。')
    await user.click(screen.getByRole('button', { name: '重新分析' }))
    expect(onRetryAnalysis).toHaveBeenCalledOnce()
    expect(screen.getByText('Agent 正在准备回答...')).toBeInTheDocument()
  })
})
