import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChannelCreateDialog } from './ChannelCreateDialog'

describe('ChannelCreateDialog', () => {
  it('submits a trimmed channel name', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ChannelCreateDialog onCreate={onCreate} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('频道名称'), ' release ')
    await user.click(screen.getByRole('button', { name: '创建频道' }))

    expect(onCreate).toHaveBeenCalledWith({ name: 'release' })
  })

  it('shows the API error without closing', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('频道已存在'))
    const user = userEvent.setup()
    render(<ChannelCreateDialog onCreate={onCreate} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('频道名称'), 'release')
    await user.click(screen.getByRole('button', { name: '创建频道' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('频道已存在')
  })
})
