import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView } from '../domain/workspace-view'
import { MessageComposer } from './MessageComposer'

const agents: AgentView[] = [
  { id: 'agent-newton', identity: 'newton', mentionName: 'dev', runtime: 'pi', status: 'idle', capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: [], createdAt: '', updatedAt: '' },
  { id: 'agent-clawd', identity: 'clawd', mentionName: 'build', runtime: 'claude-code', status: 'busy', capabilityTags: [], maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: [], createdAt: '', updatedAt: '' },
]

const localizedAgents: AgentView[] = [
  { id: 'agent-frontend-new', identity: '前端 Agent', mentionName: 'frontend', runtime: 'pi', status: 'idle', capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: [], createdAt: '', updatedAt: '2026-07-31T08:02:00.000Z' },
  { id: 'agent-frontend-old', identity: '前端 Agent', mentionName: 'frontend-old', runtime: 'claude-code', status: 'busy', capabilityTags: [], maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: [], createdAt: '', updatedAt: '2026-07-31T08:01:00.000Z' },
  { id: 'agent-review', identity: '审查 Agent', mentionName: 'review', runtime: 'opencode', status: 'idle', capabilityTags: [], maxConcurrentTasks: 1, command: 'opencode', args: [], model: '', env: [], createdAt: '', updatedAt: '2026-07-31T08:00:00.000Z' },
]

describe('MessageComposer', () => {
  it('suggests Agent names after @ and inserts the chosen name', async () => {
    const user = userEvent.setup()
    render(<MessageComposer channelName="general" agents={agents} onSend={vi.fn()} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '@')

    expect(screen.getByRole('option', { name: /@all/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /@newton/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /@clawd/ })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /@newton/ }))

    expect(composer).toHaveValue('@newton ')
  })

  it('offers @all once and lets keyboard selection insert it without sending', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<MessageComposer channelName="general" agents={agents} onSend={onSend} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '@a')

    expect(screen.getAllByRole('option', { name: /@all/ })).toHaveLength(1)
    await user.keyboard('{Enter}')

    expect(composer).toHaveValue('@all ')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('closes mention suggestions with Escape', async () => {
    const user = userEvent.setup()
    render(<MessageComposer channelName="general" agents={agents} onSend={vi.fn()} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '@')
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox', { name: '可提及 Agent' })).not.toBeInTheDocument()
  })

  it('sends on Enter and keeps a newline on Shift+Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<MessageComposer channelName="general" agents={agents} onSend={onSend} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '第一行')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(composer, '第二行')
    expect(composer).toHaveValue('第一行\n第二行')

    await user.keyboard('{Enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('第一行\n第二行'))
  })

  it('selects an Agent with arrow keys and Enter before sending a message', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<MessageComposer channelName="general" agents={agents} onSend={onSend} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '请看一下@ne')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(composer).toHaveValue('请看一下@newton ')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('filters and inserts a Chinese Agent identity that contains spaces', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<MessageComposer channelName="general" agents={localizedAgents} onSend={onSend} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '请问 @前端 A')

    expect(screen.getAllByRole('option', { name: /@前端 Agent/ })).toHaveLength(1)
    expect(screen.queryByRole('option', { name: /@外部 Agent/ })).not.toBeInTheDocument()
    await user.keyboard('{Enter}')

    expect(composer).toHaveValue('请问 @前端 Agent ')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('wraps to the last suggestion with ArrowUp and reopens suggestions after Escape when typing continues', async () => {
    const user = userEvent.setup()
    render(<MessageComposer channelName="general" agents={localizedAgents} onSend={vi.fn()} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '@')
    await user.keyboard('{ArrowUp}{Enter}')
    expect(composer).toHaveValue('@审查 Agent ')

    await user.clear(composer)
    await user.type(composer, '@')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: '可提及 Agent' })).not.toBeInTheDocument()
    await user.type(composer, '前端 A')

    expect(screen.getByRole('option', { name: /@前端 Agent/ })).toBeInTheDocument()
  })
})
