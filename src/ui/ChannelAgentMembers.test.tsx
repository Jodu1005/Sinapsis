import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView, ChannelView } from '../domain/workspace-view'
import { ChannelAgentMembers } from './ChannelAgentMembers'
import { EntityPickerDialog } from './EntityPickerDialog'

const channel: ChannelView = {
  id: 'channel-engineering', name: 'engineering', systemKey: null, memberAgentIds: ['agent-ada'], boundWorkspaceIds: ['workspace-1'], createdAt: '2026-07-29T08:00:00.000Z',
}

const ada: AgentView = {
  id: 'agent-ada', identity: 'Ada', mentionName: 'ada', runtime: 'opencode', status: 'idle', capabilityTags: ['frontend'], maxConcurrentTasks: 1, command: 'opencode', args: [], model: 'claude', env: [], createdAt: '2026-07-29T08:00:00.000Z', updatedAt: '2026-07-29T08:00:00.000Z',
}

const newton: AgentView = { ...ada, id: 'agent-newton', identity: 'Newton', mentionName: 'newton', runtime: 'pi' }

describe('ChannelAgentMembers', () => {
  it('adds an available Agent to an ordinary channel', async () => {
    const api = { addChannelAgent: vi.fn().mockResolvedValue([ada, newton]), removeChannelAgent: vi.fn() }
    const user = userEvent.setup()
    render(<ChannelAgentMembers channel={channel} agents={[ada, newton]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    expect(screen.getByRole('button', { name: '添加 Agent' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '添加 Agent' }))
    await user.click(screen.getByRole('option', { name: 'Newton' }))

    expect(api.addChannelAgent).toHaveBeenCalledWith(channel.id, newton.id)
  })

  it('closes the picker and exposes an add failure in the management section', async () => {
    const api = { addChannelAgent: vi.fn().mockRejectedValue(new Error('添加失败')), removeChannelAgent: vi.fn() }
    const user = userEvent.setup()
    render(<ChannelAgentMembers channel={channel} agents={[ada, newton]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    await user.click(screen.getByRole('button', { name: '添加 Agent' }))
    await user.click(screen.getByRole('option', { name: 'Newton' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('添加失败')
    expect(screen.queryByRole('dialog', { name: '添加 Agent' })).not.toBeInTheDocument()
  })

  it('removes a current member from an ordinary channel', async () => {
    const api = { addChannelAgent: vi.fn(), removeChannelAgent: vi.fn().mockResolvedValue([]) }
    const user = userEvent.setup()
    render(<ChannelAgentMembers channel={channel} agents={[ada, newton]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    await user.click(screen.getByRole('button', { name: '移除 Ada' }))

    expect(api.removeChannelAgent).toHaveBeenCalledWith(channel.id, ada.id)
  })

  it('shows automatic membership without mutation controls for summit', () => {
    const summit = { ...channel, id: 'channel-summit', name: 'summit', systemKey: 'summit', memberAgentIds: [] }
    render(<ChannelAgentMembers channel={summit} agents={[ada, newton]} api={{ addChannelAgent: vi.fn(), removeChannelAgent: vi.fn() }} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    expect(screen.getByText('自动同步所有 Agent')).toBeInTheDocument()
    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('Newton')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加 Agent' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /移除/ })).not.toBeInTheDocument()
  })

  it('filters and chooses exactly one entity with the keyboard', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<EntityPickerDialog title="添加 Agent" items={[
      { id: ada.id, label: ada.identity, description: 'OpenCode' },
      { id: newton.id, label: newton.identity, description: 'Pi' },
    ]} onSelect={onSelect} onClose={vi.fn()} />)

    await user.type(screen.getByRole('textbox', { name: '搜索' }), 'Pi')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(newton.id)
  })

  it('navigates options with arrow keys and closes with Escape', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<EntityPickerDialog title="添加 Agent" items={[
      { id: ada.id, label: ada.identity, description: 'OpenCode' },
      { id: newton.id, label: newton.identity, description: 'Pi' },
    ]} onSelect={onSelect} onClose={onClose} />)

    await user.keyboard('{ArrowDown}{ArrowUp}{ArrowDown}{Enter}{Escape}')

    expect(onSelect).toHaveBeenCalledWith(newton.id)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns only the first selected entity while the picker is still open', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<EntityPickerDialog title="添加 Agent" items={[
      { id: ada.id, label: ada.identity, description: 'OpenCode' },
      { id: newton.id, label: newton.identity, description: 'Pi' },
    ]} onSelect={onSelect} onClose={vi.fn()} />)

    await user.click(screen.getByRole('option', { name: 'Ada' }))
    await user.click(screen.getByRole('option', { name: 'Newton' }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(ada.id)
  })
})
