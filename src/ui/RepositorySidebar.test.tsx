import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelView, TaskView, WorkspaceView } from '../domain/workspace-view'
import { RepositorySidebar } from './RepositorySidebar'

const frontend: WorkspaceView = {
  id: 'workspace-frontend',
  name: 'Frontend',
  leaseTtlMs: 30_000,
  createdAt: '2026-07-29T08:00:00.000Z',
  repositories: [{
    id: 'repository-frontend',
    workspaceId: 'workspace-frontend',
    name: 'frontend',
    path: '/code/frontend',
    currentBranch: 'main',
    defaultBranch: 'main',
    isClean: true,
    createdAt: '2026-07-29T08:00:00.000Z',
  }],
}

const unbound: WorkspaceView = {
  ...frontend,
  id: 'workspace-unbound',
  name: 'Unbound Workspace',
  repositories: [{
    ...frontend.repositories[0],
    id: 'repository-unbound',
    workspaceId: 'workspace-unbound',
    name: 'unbound',
    path: '/code/unbound',
  }],
}

const release: ChannelView = {
  id: 'channel-release',
  name: 'release',
  systemKey: null,
  memberAgentIds: [],
  boundWorkspaceIds: [frontend.id],
  createdAt: '2026-07-29T08:00:00.000Z',
}

const frontendTask = {
  id: 'task-frontend',
  workspaceId: frontend.id,
  repositoryId: frontend.repositories[0].id,
  channelId: release.id,
  directAgentId: null,
  title: 'Ship frontend',
  description: 'Ship frontend',
  acceptanceCriteria: 'Released',
  labels: [],
  status: 'queued',
  queuedAt: '2026-07-29T08:00:00.000Z',
  attemptCount: 0,
  maxRetries: 2,
  timeoutMs: 3_600_000,
  leaseTtlMs: null,
  branchName: null,
  worktreePath: null,
  createdAt: '2026-07-29T08:00:00.000Z',
  updatedAt: '2026-07-29T08:00:00.000Z',
} satisfies TaskView

describe('RepositorySidebar', () => {
  it('shows only the selected channel bound workspaces before that workspace tasks', async () => {
    const user = userEvent.setup()
    const props = {
      workspace: unbound,
      workspaces: [frontend, unbound],
      agents: [],
      channels: [release],
      tasks: [frontendTask, { ...frontendTask, id: 'task-unbound', workspaceId: unbound.id, repositoryId: unbound.repositories[0].id, title: 'Unbound task' }],
      selectedChannelId: release.id,
      selectedWorkspaceId: frontend.id,
      selectedTaskId: null,
      onSelectChannel: vi.fn(),
      onSelectWorkspace: vi.fn(),
      onSelectTask: vi.fn(),
      onCreateTask: vi.fn(),
      onCreateChannel: vi.fn(),
      onArchiveChannel: vi.fn(),
      onRestoreChannel: vi.fn(),
      channelReadOnly: false,
      onCreateWorkspace: vi.fn(),
      onSelectAgent: vi.fn(),
      onCreateAgent: vi.fn(),
      pendingMemoryCandidateCount: 0,
      dreamSelected: false,
      onSelectDream: vi.fn(),
      tasksSelected: false,
      onSelectTasks: vi.fn(),
      mobileOpen: false,
      mobileHidden: false,
      onClose: vi.fn(),
    }

    render(<RepositorySidebar {...props} />)

    await user.click(screen.getByRole('button', { name: '# release' }))
    const workspaceGroup = screen.getByRole('group', { name: 'release 的工作空间' })
    expect(workspaceGroup).toHaveTextContent('Frontend')
    expect(screen.queryByText('Unbound Workspace')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Frontend 的任务' })).toHaveTextContent('Ship frontend')
    expect(screen.queryByText('Unbound task')).not.toBeInTheDocument()

    const navigation = screen.getByRole('navigation', { name: '工作空间' })
    const channelHeading = navigation.querySelector('.sidebar-channel-heading')!
    const workspaceList = within(navigation).getByRole('group', { name: 'release 的工作空间' })
    const taskList = within(navigation).getByRole('group', { name: 'Frontend 的任务' })
    expect(channelHeading.compareDocumentPosition(workspaceList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(workspaceList.compareDocumentPosition(taskList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders the fixed Dream entry with the pending review count', async () => {
    const user = userEvent.setup()
    const onSelectDream = vi.fn()
    render(<RepositorySidebar
      workspaces={[frontend]}
      agents={[]}
      channels={[release]}
      tasks={[]}
      selectedChannelId={release.id}
      selectedWorkspaceId={frontend.id}
      selectedTaskId={null}
      onSelectChannel={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onSelectTask={vi.fn()}
      onCreateTask={vi.fn()}
      onCreateChannel={vi.fn()}
      onArchiveChannel={vi.fn()}
      onRestoreChannel={vi.fn()}
      channelReadOnly={false}
      onCreateWorkspace={vi.fn()}
      onSelectAgent={vi.fn()}
      onCreateAgent={vi.fn()}
      pendingMemoryCandidateCount={3}
      dreamSelected={false}
      onSelectDream={onSelectDream}
      tasksSelected={false}
      onSelectTasks={vi.fn()}
      mobileOpen={false}
      mobileHidden={false}
      onClose={vi.fn()}
    />)

    const dream = screen.getByRole('button', { name: 'Dream（3 个待确认）' })
    await user.click(dream)

    expect(onSelectDream).toHaveBeenCalledOnce()
  })
})
