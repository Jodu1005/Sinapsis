import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView, RepositoryView, TaskView, WorkspaceView } from '../domain/workspace-view'
import { AgentConfigDialog } from './AgentConfigDialog'
import { TaskComposerPanel } from './TaskComposerPanel'

const repository: RepositoryView = {
  id: 'repo-1', workspaceId: 'workspace-1', name: 'sinapsis', path: '/code/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
  createdAt: '2026-07-25T08:00:00.000Z',
}
const workspace: WorkspaceView = {
  id: 'workspace-1', name: 'Sinapsis', leaseTtlMs: 30_000, createdAt: '2026-07-25T08:00:00.000Z', repositories: [repository],
}
const secondWorkspace: WorkspaceView = {
  ...workspace,
  id: 'workspace-2',
  name: 'Release',
  repositories: [{ ...repository, id: 'repo-2', workspaceId: 'workspace-2', name: 'release', path: '/code/release' }],
}
const agent: AgentView = {
  id: 'agent-1', identity: '实现 Agent', mentionName: 'builder', runtime: 'opencode', status: 'idle', capabilityTags: ['frontend'], maxConcurrentTasks: 1,
  command: 'opencode', args: [], model: 'claude', env: [], createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
}

describe('TaskComposerPanel', () => {
  it('shows the working directory and sends editable labels with a direct @agent assignment', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    const user = userEvent.setup()
    render(<TaskComposerPanel workspaces={[workspace]} agents={[agent]} onCreate={onCreate} onClose={vi.fn()} />)

    expect(screen.getByLabelText('工作空间')).toHaveValue(workspace.id)
    expect(screen.getByLabelText('工作空间')).toBeDisabled()
    expect(screen.getByLabelText('当前工作目录')).toHaveValue('/code/sinapsis')
    await user.type(screen.getByLabelText('任务标题'), '补齐移动端抽屉')
    await user.type(screen.getByLabelText('详细描述'), '修复窄屏下的导航遮挡。')
    await user.type(screen.getByLabelText('验收标准'), '390px 可操作且没有遮挡。')
    await user.clear(screen.getByLabelText('标签'))
    await user.type(screen.getByLabelText('标签'), 'frontend, responsive')
    await user.selectOptions(screen.getByLabelText('指定 Agent'), 'agent-1')
    expect(screen.getByText('@实现 Agent 将直接领取此任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    expect(onCreate).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      title: '补齐移动端抽屉', description: '修复窄屏下的导航遮挡。', acceptanceCriteria: '390px 可操作且没有遮挡。',
      labels: ['frontend', 'responsive'], directAgentId: 'agent-1',
    })
  })

  it('requires an explicit workspace when the channel has multiple bindings', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    render(<TaskComposerPanel workspaces={[workspace, secondWorkspace]} agents={[agent]} onCreate={onCreate} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('任务标题'), '准备发布')
    await user.type(screen.getByLabelText('详细描述'), '完成发布工作。')
    await user.type(screen.getByLabelText('验收标准'), '发布成功。')
    expect(screen.getByLabelText('工作空间')).toHaveValue('')
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('工作空间'), secondWorkspace.id)
    expect(screen.getByLabelText('当前工作目录')).toHaveValue('/code/release')
    expect(screen.getByRole('button', { name: '创建任务' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: secondWorkspace.id }))
  })

  it('blocks task creation when the channel has no bound workspace', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(<TaskComposerPanel workspaces={[]} agents={[agent]} onCreate={onCreate} onClose={vi.fn()} />)

    expect(screen.getByText('请先为频道绑定工作空间')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows the managed runtime preset and masks configured environment values', () => {
    render(<AgentConfigDialog agent={{ ...agent, env: ['API_TOKEN'] }} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateResponsibilities={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />)

    expect(screen.getByText('Runtime 可用性')).toBeInTheDocument()
    expect(screen.getByText('预设')).toBeInTheDocument()
    expect(screen.getByText('OpenCode 受管运行')).toBeInTheDocument()
    expect(screen.getByText('API_TOKEN（已配置）')).toBeInTheDocument()
    expect(screen.queryByText('example-secret')).not.toBeInTheDocument()
  })

  it('saves editable responsibilities from the Agent configuration', async () => {
    const user = userEvent.setup()
    const onUpdateResponsibilities = vi.fn().mockResolvedValue(undefined)
    render(<AgentConfigDialog agent={agent} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateResponsibilities={onUpdateResponsibilities} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('职责'), '前端界面与交互\n组件测试')
    await user.click(screen.getByRole('button', { name: '保存职责' }))

    expect(onUpdateResponsibilities).toHaveBeenCalledWith(['前端界面与交互', '组件测试'])
  })

  it('traps focus in the task dialog and restores the trigger after escape', async () => {
    const user = userEvent.setup()
    render(<TaskComposerHarness />)

    const trigger = screen.getByRole('button', { name: '打开新任务' })
    await user.click(trigger)
    const title = await screen.findByLabelText('任务标题')
    expect(title).toHaveFocus()
    expect(trigger).toHaveAttribute('inert')

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: '关闭新任务面板' })).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('focuses the Agent configuration dialog and restores its trigger after close', async () => {
    const user = userEvent.setup()
    render(<AgentConfigHarness />)

    const trigger = screen.getByRole('button', { name: '查看 Agent 配置' })
    await user.click(trigger)
    expect(await screen.findByRole('button', { name: '关闭 Agent 配置' })).toHaveFocus()
    expect(trigger).toHaveAttribute('inert')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(trigger).toHaveFocus())
  })
})

function TaskComposerHarness() {
  const [open, setOpen] = useState(false)
  return <div className="workspace-shell"><button type="button" onClick={() => setOpen(true)}>打开新任务</button>{open && <TaskComposerPanel workspaces={[workspace]} agents={[agent]} onCreate={vi.fn()} onClose={() => setOpen(false)} />}</div>
}

function AgentConfigHarness() {
  const [open, setOpen] = useState(false)
  return <div className="workspace-shell"><button type="button" onClick={() => setOpen(true)}>查看 Agent 配置</button>{open && <AgentConfigDialog agent={agent} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateResponsibilities={vi.fn().mockResolvedValue(undefined)} onClose={() => setOpen(false)} />}</div>
}
