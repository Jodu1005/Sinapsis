import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceApi } from '../api/client'
import type { ChannelView, MemoryCandidateView } from '../domain/workspace-view'
import { DreamCenter } from './DreamCenter'

const channel: ChannelView = {
  id: 'channel-source', name: 'source', systemKey: null, memberAgentIds: [], boundWorkspaceIds: [], createdAt: '2026-08-01T00:00:00.000Z',
}

const candidate: MemoryCandidateView = {
  id: 'candidate-1', dreamRunId: 'run-1', proposedScope: 'channel', channelId: channel.id, kind: 'fact',
  proposedContent: 'React 是前端标准。', rationale: '重复确认。', confidence: 0.9, importance: 0.8, status: 'pending',
  reviewedContent: null, reviewedScope: null, reviewedChannelId: null, reviewedAt: null, createdAt: '2026-08-01T08:00:00.000Z',
  sources: [{ channelId: channel.id, channelName: channel.name, messageId: 'message-1' }], sourceMessageCount: 1,
}

function api(overrides: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    listMemoryCandidates: vi.fn().mockResolvedValue([candidate]),
    startDream: vi.fn().mockResolvedValue([{ id: 'run-1', scope: 'channel', scopeId: channel.id, trigger: 'manual', status: 'completed', candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: '2026-08-01T08:01:00.000Z', error: null }]),
    ...overrides,
  } as WorkspaceApi
}

describe('DreamCenter', () => {
  it('lists pending candidates with source metadata and can switch review tabs', async () => {
    const user = userEvent.setup()
    const listMemoryCandidates = vi.fn().mockResolvedValue([candidate])
    render(<DreamCenter api={api({ listMemoryCandidates })} channels={[channel]} onJumpToSource={vi.fn()} />)

    expect((await screen.findAllByText('React 是前端标准。')).length).toBeGreaterThan(0)
    expect(screen.getByText('频道 · source · 1 条来源')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '已忽略' }))

    await waitFor(() => expect(listMemoryCandidates).toHaveBeenLastCalledWith('ignored'))
  })

  it('reports an empty completed Dream run and a failed Dream run', async () => {
    const user = userEvent.setup()
    const startDream = vi.fn()
      .mockResolvedValueOnce([{ id: 'run-empty', scope: 'channel', scopeId: channel.id, trigger: 'manual', status: 'completed', candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: '2026-08-01T08:01:00.000Z', error: null }])
      .mockResolvedValueOnce([{ id: 'run-failed', scope: 'channel', scopeId: channel.id, trigger: 'manual', status: 'failed', candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: '2026-08-01T08:01:00.000Z', error: '运行超时' }])
    render(<DreamCenter api={api({ startDream })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.selectOptions(screen.getByLabelText('Dream 范围'), channel.id)
    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Dream 已完成，没有新增候选。')

    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Dream 运行失败：运行超时')
  })

  it('moves an accepted pending candidate into the accepted tab', async () => {
    const user = userEvent.setup()
    const listMemoryCandidates = vi.fn().mockResolvedValue([candidate])
    const acceptMemoryCandidate = vi.fn().mockResolvedValue({ id: 'memory-1' })
    render(<DreamCenter api={api({ listMemoryCandidates, acceptMemoryCandidate })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await screen.findByRole('button', { name: '接受 Memory' })
    await user.click(screen.getByRole('button', { name: '接受 Memory' }))

    await waitFor(() => expect(listMemoryCandidates).toHaveBeenLastCalledWith('accepted'))
    expect(screen.getByRole('tab', { name: '已接受' })).toHaveAttribute('aria-selected', 'true')
  })
})
