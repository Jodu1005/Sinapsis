import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'

describe('WorkspaceCreateDialog', () => {
  it('creates a workspace bound to a local working directory', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<WorkspaceCreateDialog onCreate={onCreate} onClose={vi.fn()} />)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('工作空间名称'), '营销站')
    await user.type(screen.getByLabelText('工作目录'), '/Users/jodu/Projects/marketing-site')
    await user.click(screen.getByRole('button', { name: '添加工作空间' }))

    expect(onCreate).toHaveBeenCalledWith({ name: '营销站', directory: '/Users/jodu/Projects/marketing-site' })
  })
})
