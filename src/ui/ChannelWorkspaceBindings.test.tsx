import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelView, WorkspaceView } from '../domain/workspace-view'
import { ChannelWorkspaceBindings } from './ChannelWorkspaceBindings'

const channel: ChannelView = {
  id: 'channel-engineering', name: 'engineering', systemKey: null, memberAgentIds: [], boundWorkspaceIds: ['workspace-1'], createdAt: '2026-07-29T08:00:00.000Z',
}

const workspace: WorkspaceView = {
  id: 'workspace-1', name: 'Sinapsis', leaseTtlMs: 30_000, createdAt: '2026-07-29T08:00:00.000Z', repositories: [],
}
const releaseWorkspace: WorkspaceView = {
  ...workspace, id: 'workspace-2', name: 'Release',
}

describe('ChannelWorkspaceBindings', () => {
  it('binds a workspace selected from the global workspace list', async () => {
    const api = { bindChannelWorkspace: vi.fn().mockResolvedValue([workspace, releaseWorkspace]), unbindChannelWorkspace: vi.fn() }
    const onChanged = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ChannelWorkspaceBindings channel={channel} workspaces={[workspace, releaseWorkspace]} limit={5} api={api} onChanged={onChanged} />)

    await user.click(screen.getByRole('button', { name: '添加工作空间' }))
    await user.click(screen.getByRole('option', { name: 'Release' }))

    expect(api.bindChannelWorkspace).toHaveBeenCalledWith(channel.id, releaseWorkspace.id)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('closes the picker and exposes a binding failure in the management section', async () => {
    const api = { bindChannelWorkspace: vi.fn().mockRejectedValue(new Error('绑定失败')), unbindChannelWorkspace: vi.fn() }
    const user = userEvent.setup()
    render(<ChannelWorkspaceBindings channel={channel} workspaces={[workspace, releaseWorkspace]} limit={5} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    await user.click(screen.getByRole('button', { name: '添加工作空间' }))
    await user.click(screen.getByRole('option', { name: 'Release' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('绑定失败')
    expect(screen.queryByRole('dialog', { name: '添加工作空间' })).not.toBeInTheDocument()
  })

  it('disables adding when the channel reaches its workspace limit', () => {
    render(<ChannelWorkspaceBindings channel={{ ...channel, boundWorkspaceIds: ['1', '2', '3', '4', '5'] }} workspaces={[workspace]} limit={5} api={{ bindChannelWorkspace: vi.fn(), unbindChannelWorkspace: vi.fn() }} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    expect(screen.getByText('5/5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加工作空间' })).toBeDisabled()
  })

  it('confirms an unbind without deleting local files', async () => {
    const api = { bindChannelWorkspace: vi.fn(), unbindChannelWorkspace: vi.fn().mockResolvedValue([]) }
    const user = userEvent.setup()
    render(<ChannelWorkspaceBindings channel={channel} workspaces={[workspace]} limit={5} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    await user.click(screen.getByRole('button', { name: '解绑 Sinapsis' }))
    const dialog = screen.getByRole('dialog', { name: '解绑 Sinapsis' })
    expect(within(dialog).getByText('不会删除本地文件。')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '解绑工作空间' }))

    expect(api.unbindChannelWorkspace).toHaveBeenCalledWith(channel.id, workspace.id)
  })

  it('keeps an unbind failure inside the confirmation dialog', async () => {
    const api = { bindChannelWorkspace: vi.fn(), unbindChannelWorkspace: vi.fn().mockRejectedValue(new Error('解绑失败')) }
    const user = userEvent.setup()
    render(<ChannelWorkspaceBindings channel={channel} workspaces={[workspace]} limit={5} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    await user.click(screen.getByRole('button', { name: '解绑 Sinapsis' }))
    const dialog = screen.getByRole('dialog', { name: '解绑 Sinapsis' })
    await user.click(within(dialog).getByRole('button', { name: '解绑工作空间' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('解绑失败')
  })
})
