import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChannelTimeline } from './ChannelTimeline'

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
})
