import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView, ChannelView, RepositoryView, TaskView, WorkspaceView } from '../domain/workspace-view'
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
const channel: ChannelView = {
  id: 'channel-1', name: 'general', systemKey: null, memberAgentIds: [agent.id], boundWorkspaceIds: [workspace.id], createdAt: '2026-07-25T08:00:00.000Z',
}

describe('TaskComposerPanel', () => {
  it('shows the working directory and sends editable labels with a direct @agent assignment', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    const user = userEvent.setup()
    render(<TaskComposerPanel workspaces={[workspace]} channels={[channel]} agents={[agent]} initialWorkspaceId={workspace.id} onBrowseDirectory={vi.fn().mockResolvedValue(null)} onCreate={onCreate} onClose={vi.fn()} />)

    expect(screen.getByLabelText('频道')).toHaveValue(channel.id)
    expect(screen.getByLabelText('工作目录')).toHaveValue('/code/sinapsis')
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
    }, channel.id)
  })

  it('uses a browsed directory that belongs to an existing workspace', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    const onBrowseDirectory = vi.fn().mockResolvedValue('/code/release')
    render(<TaskComposerPanel workspaces={[workspace, secondWorkspace]} channels={[channel]} agents={[agent]} initialWorkspaceId={workspace.id} onBrowseDirectory={onBrowseDirectory} onCreate={onCreate} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('任务标题'), '准备发布')
    await user.type(screen.getByLabelText('详细描述'), '完成发布工作。')
    await user.type(screen.getByLabelText('验收标准'), '发布成功。')
    await user.click(screen.getByRole('button', { name: '浏览电脑目录' }))
    expect(onBrowseDirectory).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('工作目录')).toHaveValue('/code/release')
    expect(screen.getByText('使用已有工作空间：Release')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: secondWorkspace.id, directory: undefined }), channel.id)
  })

  it('creates a task without a completion definition', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    render(<TaskComposerPanel workspaces={[workspace]} channels={[channel]} agents={[agent]} initialWorkspaceId={workspace.id} onBrowseDirectory={vi.fn().mockResolvedValue(null)} onCreate={onCreate} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('详细描述'), '先完成一次预分析。')
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    expect(onCreate).toHaveBeenCalledWith(expect.not.objectContaining({ title: expect.anything(), acceptanceCriteria: expect.anything() }), channel.id)
  })

  it('returns a new browsed directory for automatic workspace creation', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    render(<TaskComposerPanel
      workspaces={[]}
      channels={[channel]}
      agents={[agent]}
      onBrowseDirectory={vi.fn().mockResolvedValue('/Users/jodu/Projects/new-app')}
      onCreate={onCreate}
      onClose={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '浏览电脑目录' }))
    expect(screen.getByLabelText('工作目录')).toHaveValue('/Users/jodu/Projects/new-app')
    expect(screen.getByText('将以此目录创建工作空间：new-app')).toBeInTheDocument()
    await user.type(screen.getByLabelText('任务标题'), '建立任务')
    await user.type(screen.getByLabelText('详细描述'), '使用新目录。')
    await user.type(screen.getByLabelText('验收标准'), '目录已登记。')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: undefined, directory: '/Users/jodu/Projects/new-app' }), channel.id)
  })

  it('updates the agent choices when manually changing the channel', async () => {
    const user = userEvent.setup()
    const otherAgent = { ...agent, id: 'agent-2', identity: '审核 Agent', mentionName: 'reviewer' }
    const otherChannel = { ...channel, id: 'channel-2', name: 'review', memberAgentIds: [otherAgent.id] }
    render(<TaskComposerPanel workspaces={[workspace]} channels={[channel, otherChannel]} agents={[agent, otherAgent]} initialWorkspaceId={workspace.id} onBrowseDirectory={vi.fn().mockResolvedValue(null)} onCreate={vi.fn()} onClose={vi.fn()} />)

    expect(within(screen.getByLabelText('指定 Agent')).getByRole('option', { name: /实现 Agent/ })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('频道'), otherChannel.id)
    expect(within(screen.getByLabelText('指定 Agent')).getByRole('option', { name: /审核 Agent/ })).toBeInTheDocument()
    expect(within(screen.getByLabelText('指定 Agent')).queryByRole('option', { name: /实现 Agent/ })).not.toBeInTheDocument()
  })

  it('shows the managed runtime preset and masks configured environment values', () => {
    render(<AgentConfigDialog agent={{ ...agent, env: ['API_TOKEN'] }} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateIdentity={vi.fn().mockResolvedValue(undefined)} onUpdateResponsibilities={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />)

    expect(screen.getByText('Runtime 可用性')).toBeInTheDocument()
    expect(screen.getByText('预设')).toBeInTheDocument()
    expect(screen.getByText('OpenCode CLI 受管运行')).toBeInTheDocument()
    expect(screen.getByText('API_TOKEN（已配置）')).toBeInTheDocument()
    expect(screen.queryByText('example-secret')).not.toBeInTheDocument()
  })

  it('saves editable responsibilities from the Agent configuration', async () => {
    const user = userEvent.setup()
    const onUpdateResponsibilities = vi.fn().mockResolvedValue(undefined)
    render(<AgentConfigDialog agent={agent} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateIdentity={vi.fn().mockResolvedValue(undefined)} onUpdateResponsibilities={onUpdateResponsibilities} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('职责'), '前端界面与交互\n组件测试')
    await user.click(screen.getByRole('button', { name: '保存职责' }))

    expect(onUpdateResponsibilities).toHaveBeenCalledWith(['前端界面与交互', '组件测试'])
  })

  it('saves an edited Agent name from the configuration dialog', async () => {
    const user = userEvent.setup()
    const onUpdateIdentity = vi.fn().mockResolvedValue(undefined)
    render(<AgentConfigDialog agent={agent} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateIdentity={onUpdateIdentity} onUpdateResponsibilities={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />)

    await user.clear(screen.getByLabelText('名称'))
    await user.type(screen.getByLabelText('名称'), '前端专家')
    await user.click(screen.getByRole('button', { name: '保存名称' }))

    expect(onUpdateIdentity).toHaveBeenCalledWith('前端专家')
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === '名称用于频道显示和 @ 提及；原有 @builder 仍然可用。')).toBeInTheDocument()
  })

  it('traps focus in the task dialog and restores the trigger after escape', async () => {
    const user = userEvent.setup()
    render(<TaskComposerHarness />)

    const trigger = screen.getByRole('button', { name: '打开新任务' })
    await user.click(trigger)
    const description = await screen.findByLabelText('详细描述')
    expect(description).toHaveFocus()
    expect(trigger).toHaveAttribute('inert')

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByLabelText('任务标题')).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(screen.getByLabelText('详细描述')).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(screen.getByLabelText('验收标准')).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(screen.getByLabelText('频道')).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(screen.getByRole('button', { name: '浏览电脑目录' })).toHaveFocus()
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
  return <div className="workspace-shell"><button type="button" onClick={() => setOpen(true)}>打开新任务</button>{open && <TaskComposerPanel workspaces={[workspace]} channels={[channel]} agents={[agent]} initialWorkspaceId={workspace.id} onBrowseDirectory={vi.fn().mockResolvedValue(null)} onCreate={vi.fn()} onClose={() => setOpen(false)} />}</div>
}

function AgentConfigHarness() {
  const [open, setOpen] = useState(false)
  return <div className="workspace-shell"><button type="button" onClick={() => setOpen(true)}>查看 Agent 配置</button>{open && <AgentConfigDialog agent={agent} refreshingRuntime={false} onRefreshRuntime={vi.fn().mockResolvedValue(undefined)} onUpdateIdentity={vi.fn().mockResolvedValue(undefined)} onUpdateResponsibilities={vi.fn().mockResolvedValue(undefined)} onClose={() => setOpen(false)} />}</div>
}
