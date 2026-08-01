import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView, ChannelMessage, TurnActivityView } from '../domain/workspace-view'
import { ChannelTimeline } from './ChannelTimeline'

const agents: AgentView[] = [
  {
    id: 'agent-newton', identity: 'Newton', mentionName: 'newton', runtime: 'pi', status: 'busy',
    capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: [], createdAt: '2026-07-31T08:00:00.000Z', updatedAt: '2026-07-31T08:00:00.000Z',
  },
  {
    id: 'agent-clawd', identity: 'Clawd', mentionName: 'clawd', runtime: 'claude-code', status: 'busy',
    capabilityTags: [], maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: [], createdAt: '2026-07-31T08:00:00.000Z', updatedAt: '2026-07-31T08:00:00.000Z',
  },
]

const humanMessage: ChannelMessage = {
  id: 'message-1',
  channelId: 'channel-1',
  taskId: null,
  senderType: 'human',
  senderId: null,
  authorName: 'You',
  body: '请评估这个前端改动。',
  createdAt: '2026-07-31T08:01:00.000Z',
  updatedAt: '2026-07-31T08:01:00.000Z',
  deletedAt: null,
}

const activities: TurnActivityView[] = [
  { turnId: 'turn-1', agentId: null, phase: 'screening', queuePosition: null },
  { turnId: 'turn-1', agentId: 'agent-newton', phase: 'judging', queuePosition: null },
  { turnId: 'turn-1', agentId: 'agent-clawd', phase: 'queued', queuePosition: 2 },
  { turnId: 'turn-2', agentId: 'agent-newton', phase: 'preparing', queuePosition: null },
]

describe('ChannelTimeline', () => {
  it('places people and agents in distinct conversational roles without exposing the system name', () => {
    const { container } = render(<ChannelTimeline messages={[
      { id: 'human-1', channelId: 'channel-1', taskId: null, senderType: 'human', senderId: null, authorName: 'You', body: '请开始处理。', createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z', deletedAt: null },
      { id: 'agent-1', channelId: 'channel-1', taskId: 'task-1', senderType: 'agent', senderId: 'agent-1', authorName: 'Ava', body: '我正在处理。', createdAt: '2026-07-25T08:01:00.000Z', updatedAt: '2026-07-25T08:01:00.000Z', deletedAt: null },
      { id: 'system-1', channelId: 'channel-1', taskId: null, senderType: 'system', senderId: null, authorName: 'Sinapsis', body: '旧事件。', createdAt: '2026-07-25T08:02:00.000Z', updatedAt: '2026-07-25T08:02:00.000Z', deletedAt: null },
    ]} />)

    expect(screen.getByText('你')).toBeInTheDocument()
    expect(screen.getByText('Ava')).toBeInTheDocument()
    expect(screen.getByText('系统')).toBeInTheDocument()
    expect(screen.queryByText('Sinapsis')).not.toBeInTheDocument()
    expect(container.querySelector('.message-human')).toBeInTheDocument()
    expect(container.querySelector('.message-agent')).toBeInTheDocument()
  })

  it('shows an Agent typing indicator while a reply is being prepared', () => {
    render(<ChannelTimeline messages={[]} typingAgents={[{
      id: 'agent-1', identity: 'Newton', mentionName: 'newton', runtime: 'pi', status: 'busy',
      capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: [], createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
    }]} />)

    expect(screen.getByRole('status')).toHaveTextContent('Newton 正在准备回复')
  })

  it('shows stable multi-agent turn activity at the bottom of the timeline', async () => {
    const user = userEvent.setup()
    const openTurn = vi.fn()
    render(<ChannelTimeline messages={[humanMessage]} agents={agents} turnActivities={activities} onOpenTurn={openTurn} />)

    expect(screen.getByText('正在筛选职责')).toBeInTheDocument()
    expect(screen.getByText('Newton 正在判断是否参与')).toBeInTheDocument()
    expect(screen.getByText('Clawd 排队中（第 2 位）')).toBeInTheDocument()
    expect(screen.getByText('Newton 正在准备回复')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '查看 Turn turn-1 活动详情' }))

    expect(openTurn).toHaveBeenCalledWith('turn-1')
  })

  it('removes the preparing activity once the matching Agent reply is visible', () => {
    render(<ChannelTimeline messages={[
      humanMessage,
      {
        id: 'message-2',
        channelId: 'channel-1',
        taskId: null,
        senderType: 'agent',
        senderId: 'agent-newton',
        authorName: 'Newton',
        body: '我已经完成第一轮判断。',
        createdAt: '2026-07-31T08:02:00.000Z',
        updatedAt: '2026-07-31T08:02:00.000Z',
        deletedAt: null,
      },
    ]} agents={agents} turnActivities={[activities[3]!]} />)

    expect(screen.queryByText('Newton 正在准备回复')).not.toBeInTheDocument()
  })
})
