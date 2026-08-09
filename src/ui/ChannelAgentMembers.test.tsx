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
const buildClawd: AgentView = { ...ada, id: 'agent-clawd-build', identity: 'clawd', mentionName: 'build' }
const workcodeClawd: AgentView = { ...ada, id: 'agent-clawd-workcode', identity: 'clawd', mentionName: 'clawd-workcode' }

describe('ChannelAgentMembers', () => {
  it('distinguishes members that share an identity by mention name', async () => {
    const duplicateChannel = { ...channel, memberAgentIds: [buildClawd.id, workcodeClawd.id] }
    const api = { addChannelAgent: vi.fn(), removeChannelAgent: vi.fn().mockResolvedValue([]) }
    const user = userEvent.setup()
    render(<ChannelAgentMembers channel={duplicateChannel} agents={[buildClawd, workcodeClawd]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    expect(screen.getByRole('heading', { name: '当前频道 Agent' })).toBeInTheDocument()
    expect(screen.getByText(/@build/)).toBeInTheDocument()
    expect(screen.getByText(/@clawd-workcode/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '移除 clawd @build' }))

    expect(api.removeChannelAgent).toHaveBeenCalledWith(duplicateChannel.id, buildClawd.id)
    expect(screen.getByRole('button', { name: '移除 clawd @clawd-workcode' })).toBeInTheDocument()
  })

  it('adds an available Agent to an ordinary channel', async () => {
    const api = { addChannelAgent: vi.fn().mockResolvedValue([ada, newton]), removeChannelAgent: vi.fn() }
    const user = userEvent.setup()
    render(<ChannelAgentMembers channel={channel} agents={[ada, newton]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    expect(screen.getByRole('button', { name: '添加 Agent' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '添加 Agent' }))
    await user.click(screen.getByRole('option', { name: 'Newton' }))

    expect(api.addChannelAgent).toHaveBeenCalledWith(channel.id, newton.id)
  })

  it('distinguishes duplicate identities in the picker without changing unique option names', async () => {
    const emptyChannel = { ...channel, memberAgentIds: [] }
    const api = { addChannelAgent: vi.fn().mockResolvedValue([]), removeChannelAgent: vi.fn() }
    const user = userEvent.setup()
    render(<ChannelAgentMembers channel={emptyChannel} agents={[buildClawd, workcodeClawd, newton]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} />)

    await user.click(screen.getByRole('button', { name: '添加 Agent' }))

    expect(screen.getByRole('option', { name: 'clawd @build' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'clawd @clawd-workcode' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Newton' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'clawd @build' }))

    expect(api.addChannelAgent).toHaveBeenCalledWith(emptyChannel.id, buildClawd.id)
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

  it('exposes the active listbox option from the focused search input', async () => {
    const user = userEvent.setup()
    render(<EntityPickerDialog title="添加 Agent" items={[
      { id: ada.id, label: ada.identity, description: 'OpenCode' },
      { id: newton.id, label: newton.identity, description: 'Pi' },
    ]} onSelect={vi.fn()} onClose={vi.fn()} />)

    const search = screen.getByRole('textbox', { name: '搜索' })
    const listbox = screen.getByRole('listbox', { name: '添加 Agent' })
    const adaOption = screen.getByRole('option', { name: 'Ada' })
    const newtonOption = screen.getByRole('option', { name: 'Newton' })
    expect(search).toHaveFocus()
    expect(search).toHaveAttribute('aria-controls', listbox.id)
    expect(search).toHaveAttribute('aria-activedescendant', adaOption.id)
    expect(listbox).not.toHaveAttribute('aria-activedescendant')

    await user.keyboard('{ArrowDown}')

    expect(search).toHaveAttribute('aria-activedescendant', newtonOption.id)
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
