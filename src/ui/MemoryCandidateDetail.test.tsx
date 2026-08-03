import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelView, MemoryCandidateView } from '../domain/workspace-view'
import { MemoryCandidateDetail } from './MemoryCandidateDetail'

const channel: ChannelView = { id: 'channel-source', name: 'source', systemKey: null, memberAgentIds: [], boundWorkspaceIds: [], createdAt: '2026-08-01T00:00:00.000Z' }
const candidate: MemoryCandidateView = {
  id: 'candidate-1', dreamRunId: 'run-1', proposedScope: 'channel', channelId: channel.id, kind: 'fact', proposedContent: '原始内容。', rationale: '理由。', confidence: 0.9, importance: 0.8, status: 'pending', reviewedContent: null, reviewedScope: null, reviewedChannelId: null, reviewedAt: null, createdAt: '2026-08-01T08:00:00.000Z', sources: [{ channelId: channel.id, channelName: channel.name, messageId: 'message-1', threadRootMessageId: null }], sourceMessageCount: 1,
}

describe('MemoryCandidateDetail', () => {
  it('locks review actions while accepting, then returns the accepted candidate and source jump', async () => {
    const user = userEvent.setup()
    let resolveAccept: () => void = () => undefined
    const onAccept = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveAccept = resolve }))
    const onJumpToSource = vi.fn()
    render(<MemoryCandidateDetail candidate={candidate} channels={[channel]} onAccept={onAccept} onIgnore={vi.fn()} onJumpToSource={onJumpToSource} />)

    await user.clear(screen.getByLabelText('Memory 内容'))
    await user.type(screen.getByLabelText('Memory 内容'), '编辑后的内容。')
    await user.click(screen.getByRole('button', { name: '接受 Memory' }))

    expect(onAccept).toHaveBeenCalledWith({ scope: 'channel', channelId: channel.id, content: '编辑后的内容。' })
    expect(screen.getByRole('button', { name: '接受 Memory' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '忽略候选' })).toBeDisabled()
    resolveAccept()
    await user.click(screen.getByRole('button', { name: '跳转到 # source 的来源消息' }))
    expect(onJumpToSource).toHaveBeenCalledWith(channel.id, 'message-1')
  })

  it('shows every source and presents reviewed values as read-only', async () => {
    const user = userEvent.setup()
    const reviewed = {
      ...candidate,
      status: 'accepted' as const,
      reviewedContent: '人工确认后的内容。',
      reviewedScope: 'global' as const,
      reviewedChannelId: null,
      sources: [
        ...candidate.sources,
        { channelId: 'channel-second', channelName: 'second', messageId: 'message-2', threadRootMessageId: null },
      ],
      sourceMessageCount: 2,
    }
    const onJumpToSource = vi.fn()
    render(<MemoryCandidateDetail candidate={reviewed} channels={[channel]} onAccept={vi.fn()} onIgnore={vi.fn()} onJumpToSource={onJumpToSource} />)

    expect(screen.getByLabelText('Memory 内容')).toHaveValue('人工确认后的内容。')
    expect(screen.getByLabelText('Memory 内容')).toBeDisabled()
    expect(screen.getByLabelText('Memory Scope')).toBeDisabled()
    expect(screen.queryByRole('button', { name: '接受 Memory' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '跳转到 # source 的来源消息' }))
    await user.click(screen.getByRole('button', { name: '跳转到 # second 的来源消息 2' }))
    expect(onJumpToSource).toHaveBeenNthCalledWith(1, channel.id, 'message-1')
    expect(onJumpToSource).toHaveBeenNthCalledWith(2, 'channel-second', 'message-2')
  })
})
