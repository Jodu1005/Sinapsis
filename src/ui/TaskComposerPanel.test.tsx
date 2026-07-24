import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentView, RepositoryView, TaskView } from '../domain/workspace-view'
import { AgentConfigDialog } from './AgentConfigDialog'
import { TaskComposerPanel } from './TaskComposerPanel'

const repository: RepositoryView = {
  id: 'repo-1', workspaceId: 'workspace-1', name: 'sinapsis', path: '/code/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
  createdAt: '2026-07-25T08:00:00.000Z', channels: [{ id: 'channel-1', repositoryId: 'repo-1', name: 'general', createdAt: '2026-07-25T08:00:00.000Z' }], tasks: [],
}
const agent: AgentView = {
  id: 'agent-1', workspaceId: 'workspace-1', identity: '实现 Agent', mentionName: 'builder', runtime: 'opencode', status: 'idle', capabilityTags: ['frontend'], maxConcurrentTasks: 1,
  command: 'opencode', args: [], model: 'claude', env: [], createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
}

describe('TaskComposerPanel', () => {
  it('inherits the repository context and sends editable labels with a direct @agent assignment', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'task-1' } as TaskView)
    const user = userEvent.setup()
    render(<TaskComposerPanel repository={repository} agents={[agent]} onCreate={onCreate} onClose={vi.fn()} />)

    expect(screen.getByDisplayValue('sinapsis')).toBeDisabled()
    await user.type(screen.getByLabelText('任务标题'), '补齐移动端抽屉')
    await user.type(screen.getByLabelText('详细描述'), '修复窄屏下的导航遮挡。')
    await user.type(screen.getByLabelText('验收标准'), '390px 可操作且没有遮挡。')
    await user.clear(screen.getByLabelText('标签'))
    await user.type(screen.getByLabelText('标签'), 'frontend, responsive')
    await user.selectOptions(screen.getByLabelText('指定 Agent'), 'agent-1')
    expect(screen.getByText('@builder 将直接领取此任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    expect(onCreate).toHaveBeenCalledWith({
      title: '补齐移动端抽屉', description: '修复窄屏下的导航遮挡。', acceptanceCriteria: '390px 可操作且没有遮挡。',
      labels: ['frontend', 'responsive'], directAgentId: 'agent-1',
    })
  })

  it('shows the managed runtime preset and masks configured environment values', () => {
    render(<AgentConfigDialog agent={{ ...agent, env: ['API_TOKEN'] }} onClose={vi.fn()} />)

    expect(screen.getByText('Runtime 可用性')).toBeInTheDocument()
    expect(screen.getByText('预设')).toBeInTheDocument()
    expect(screen.getByText('OpenCode 受管运行')).toBeInTheDocument()
    expect(screen.getByText('API_TOKEN（已配置）')).toBeInTheDocument()
    expect(screen.queryByText('example-secret')).not.toBeInTheDocument()
  })
})
