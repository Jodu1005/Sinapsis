import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView } from '../domain/workspace-view'
import { MessageComposer } from './MessageComposer'

const agents: AgentView[] = [
  { id: 'agent-newton', identity: 'newton', mentionName: 'dev', runtime: 'pi', status: 'idle', capabilityTags: [], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: [], createdAt: '', updatedAt: '' },
  { id: 'agent-clawd', identity: 'clawd', mentionName: 'build', runtime: 'claude-code', status: 'busy', capabilityTags: [], maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: [], createdAt: '', updatedAt: '' },
]

describe('MessageComposer', () => {
  it('suggests Agent names after @ and inserts the chosen name', async () => {
    const user = userEvent.setup()
    render(<MessageComposer channelName="general" agents={agents} onSend={vi.fn()} />)

    const composer = screen.getByRole('textbox', { name: '发送消息' })
    await user.type(composer, '@')

    expect(screen.getByRole('option', { name: /@newton/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /@clawd/ })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: /@newton/ }))

    expect(composer).toHaveValue('@newton ')
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
})
