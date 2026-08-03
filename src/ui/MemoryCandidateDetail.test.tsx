import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelView, MemoryCandidateView } from '../domain/workspace-view'
import { MemoryCandidateDetail } from './MemoryCandidateDetail'

const channel: ChannelView = { id: 'channel-source', name: 'source', systemKey: null, memberAgentIds: [], boundWorkspaceIds: [], createdAt: '2026-08-01T00:00:00.000Z' }
const candidate: MemoryCandidateView = {
  id: 'candidate-1', dreamRunId: 'run-1', proposedScope: 'channel', channelId: channel.id, kind: 'fact', proposedContent: '原始内容。', rationale: '理由。', confidence: 0.9, importance: 0.8, status: 'pending', reviewedContent: null, reviewedScope: null, reviewedChannelId: null, reviewedAt: null, createdAt: '2026-08-01T08:00:00.000Z', sources: [{ channelId: channel.id, channelName: channel.name, messageId: 'message-1' }], sourceMessageCount: 1,
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
})
