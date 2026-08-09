import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaskOutputFiles } from './TaskOutputFiles'

describe('TaskOutputFiles', () => {
  it('lists task outputs and renders Markdown when a file is selected', async () => {
    const user = userEvent.setup()
    const listFiles = vi.fn().mockResolvedValue([
      { path: 'docs/guide.md', status: 'added' },
      { path: 'src/sort.ts', status: 'modified' },
    ])
    const readFile = vi.fn().mockResolvedValue('# 求职指南\n\n- **准备完成**')
    render(<TaskOutputFiles taskId="task-1" onListFiles={listFiles} onReadFile={readFile} />)

    await user.click(screen.getByRole('button', { name: '文件' }))
    expect(await screen.findByRole('list', { name: '输出文件列表' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '查看 docs/guide.md' }))

    expect(readFile).toHaveBeenCalledWith('task-1', 'docs/guide.md')
    expect(await screen.findByRole('heading', { name: '求职指南' })).toBeInTheDocument()
    expect(screen.getByText('准备完成').tagName).toBe('STRONG')
  })
})
