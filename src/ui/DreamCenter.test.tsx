import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  sources: [{ channelId: channel.id, channelName: channel.name, messageId: 'message-1', threadRootMessageId: null }], sourceMessageCount: 1,
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

  it('reloads the active candidate status when the workspace refresh generation changes', async () => {
    const listMemoryCandidates = vi.fn().mockResolvedValue([candidate])
    const workspaceApi = api({ listMemoryCandidates })
    const view = render(<DreamCenter api={workspaceApi} channels={[channel]} onJumpToSource={vi.fn()} refreshGeneration={0} />)

    await waitFor(() => expect(listMemoryCandidates).toHaveBeenCalledTimes(1))
    view.rerender(<DreamCenter api={workspaceApi} channels={[channel]} onJumpToSource={vi.fn()} refreshGeneration={1} />)
    await waitFor(() => expect(listMemoryCandidates).toHaveBeenCalledTimes(2))
  })

  it('reports an empty completed Dream run and a failed Dream run', async () => {
    const user = userEvent.setup()
    const startDream = vi.fn()
      .mockResolvedValueOnce([{ id: 'run-empty', scope: 'channel', scopeId: channel.id, trigger: 'manual', status: 'completed', candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: '2026-08-01T08:01:00.000Z', error: null }])
      .mockResolvedValueOnce([{ id: 'run-failed', scope: 'channel', scopeId: channel.id, trigger: 'manual', status: 'failed', candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: '2026-08-01T08:01:00.000Z', errorCategory: 'runtime_failure' }])
    render(<DreamCenter api={api({ startDream })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.selectOptions(screen.getByLabelText('Dream 范围'), channel.id)
    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Dream 已完成，没有新增候选。'))

    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Dream 运行失败：运行环境执行失败。')
  })

  it('moves an accepted pending candidate into the accepted tab', async () => {
    const user = userEvent.setup()
    const reviewed = { ...candidate, status: 'accepted' as const, reviewedContent: '编辑后确认的内容。', reviewedScope: 'global' as const, reviewedChannelId: null }
    const listMemoryCandidates = vi.fn((nextStatus: string) => Promise.resolve(nextStatus === 'accepted' ? [reviewed] : [candidate]))
    const acceptMemoryCandidate = vi.fn().mockResolvedValue({ id: 'memory-1' })
    render(<DreamCenter api={api({ listMemoryCandidates, acceptMemoryCandidate })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await screen.findByRole('button', { name: '接受 Memory' })
    await user.clear(screen.getByLabelText('Memory 内容'))
    await user.type(screen.getByLabelText('Memory 内容'), '编辑后确认的内容。')
    await user.click(screen.getByRole('button', { name: '接受 Memory' }))

    await waitFor(() => expect(listMemoryCandidates).toHaveBeenLastCalledWith('accepted'))
    expect(screen.getByRole('tab', { name: '已接受' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByDisplayValue('编辑后确认的内容。')).toBeDisabled()
  })

  it('keeps Dream locked through queued runs and reports a terminal no-op after polling', async () => {
    const user = userEvent.setup()
    const queued = { id: 'run-queued', scope: 'channel' as const, scopeId: channel.id, trigger: 'manual' as const, status: 'queued' as const, candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: null, error: null }
    const completed = { ...queued, status: 'completed' as const, completedAt: '2026-08-01T08:01:00.000Z' }
    const listDreamRuns = vi.fn().mockResolvedValueOnce([queued]).mockResolvedValueOnce([completed])
    render(<DreamCenter api={api({ startDream: vi.fn().mockResolvedValue([queued]), listDreamRuns })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    expect(screen.getByRole('button', { name: '立即 Dream' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Dream 正在运行')
    expect(listDreamRuns).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Dream 已完成，没有新增候选。'))
  })

  it('clears the running notice for a terminal failed Dream run and shows one safe alert', async () => {
    const user = userEvent.setup()
    const queued = { id: 'run-failing', scope: 'channel' as const, scopeId: channel.id, trigger: 'manual' as const, status: 'queued' as const, candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: null, error: null }
    const failed = { ...queued, status: 'failed' as const, completedAt: '2026-08-01T08:01:00.000Z', error: 'RAW_RUNTIME_PROMPT=do-not-display', errorCategory: 'runtime_failure' }
    render(<DreamCenter api={api({ startDream: vi.fn().mockResolvedValue([queued]), listDreamRuns: vi.fn().mockResolvedValueOnce([queued]).mockResolvedValueOnce([failed]) })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    expect(screen.getByRole('button', { name: '立即 Dream' })).toBeDisabled()
    await expectDreamFailure('Dream 运行失败：运行环境执行失败。')
  })

  it('clears the running notice after a Dream poll request error', async () => {
    const user = userEvent.setup()
    const queued = { id: 'run-poll-error', scope: 'channel' as const, scopeId: channel.id, trigger: 'manual' as const, status: 'queued' as const, candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: null, error: null }
    render(<DreamCenter api={api({ startDream: vi.fn().mockResolvedValue([queued]), listDreamRuns: vi.fn().mockRejectedValue(new Error('RAW_NETWORK_TOKEN')) })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    await expectDreamFailure('Dream 运行状态查询失败，请稍后重试。')
  })

  it('clears the running notice after a Dream start error', async () => {
    const user = userEvent.setup()
    render(<DreamCenter api={api({ startDream: vi.fn().mockRejectedValue(new Error('RAW_START_FAILURE')) })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '立即 Dream' }))
    await expectDreamFailure('Dream 启动失败，请稍后重试。')
  })

  it('clears the running notice after the Dream poll times out', async () => {
    vi.useFakeTimers()
    try {
      const queued = { id: 'run-timeout', scope: 'channel' as const, scopeId: channel.id, trigger: 'manual' as const, status: 'queued' as const, candidateCount: 0, createdAt: '2026-08-01T08:00:00.000Z', startedAt: null, completedAt: null, error: null }
      render(<DreamCenter api={api({ startDream: vi.fn().mockResolvedValue([queued]), listDreamRuns: vi.fn().mockResolvedValue([queued]) })} channels={[channel]} onJumpToSource={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: '立即 Dream' }))
      await act(async () => { await Promise.resolve() })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expectVisibleDreamFailure('Dream 运行状态查询超时，请稍后刷新。')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a newer tab result when an older status request resolves last', async () => {
    let resolvePending: (items: MemoryCandidateView[]) => void = () => undefined
    const pending = new Promise<MemoryCandidateView[]>((resolve) => { resolvePending = resolve })
    const ignored = { ...candidate, id: 'candidate-ignored', status: 'ignored' as const, proposedContent: '已忽略内容。' }
    const listMemoryCandidates = vi.fn((status: string) => status === 'pending' ? pending : Promise.resolve([ignored]))
    const user = userEvent.setup()
    render(<DreamCenter api={api({ listMemoryCandidates })} channels={[channel]} onJumpToSource={vi.fn()} />)

    await user.click(screen.getByRole('tab', { name: '已忽略' }))
    expect(await screen.findByRole('button', { name: /已忽略内容。/ })).toBeInTheDocument()
    resolvePending([candidate])

    await Promise.resolve()
    expect(screen.queryByText('React 是前端标准。')).not.toBeInTheDocument()
  })

  it('implements roving keyboard tabs with tabpanel relationships', async () => {
    const user = userEvent.setup()
    render(<DreamCenter api={api()} channels={[channel]} onJumpToSource={vi.fn()} />)
    const pending = screen.getByRole('tab', { name: '待确认' })
    pending.focus()

    await user.keyboard('{ArrowRight}')

    const accepted = screen.getByRole('tab', { name: '已接受' })
    expect(accepted).toHaveFocus()
    expect(accepted).toHaveAttribute('aria-selected', 'true')
    expect(accepted).toHaveAttribute('aria-controls')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', accepted.id)

    await user.keyboard('{ArrowLeft}')
    expect(pending).toHaveFocus()
  })
})

async function expectDreamFailure(message: string): Promise<void> {
  await screen.findByRole('alert')
  expectVisibleDreamFailure(message)
}

function expectVisibleDreamFailure(message: string): void {
  expect(screen.getByRole('alert')).toHaveTextContent(message)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '立即 Dream' })).toBeEnabled()
  expect(screen.getByLabelText('Dream 范围')).toBeEnabled()
}
