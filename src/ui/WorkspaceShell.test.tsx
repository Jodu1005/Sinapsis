import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceApi } from '../api/client'
import type { TaskDetailView, TaskView, WorkspaceSnapshot } from '../domain/workspace-view'
import { WorkspaceShell } from './WorkspaceShell'

const snapshot: WorkspaceSnapshot = {
  workspaces: [{
    id: 'workspace-1', name: 'Sinapsis', leaseTtlMs: 30_000, createdAt: '2026-07-25T08:00:00.000Z',
    agents: [{
      id: 'agent-1', workspaceId: 'workspace-1', identity: '实现 Agent', mentionName: 'builder', runtime: 'opencode',
      status: 'idle', capabilityTags: ['frontend'], maxConcurrentTasks: 1, command: 'opencode', args: [], model: 'claude', env: [],
      createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
    }],
    repositories: [{
      id: 'repository-1', workspaceId: 'workspace-1', name: 'sinapsis', path: '/code/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
      createdAt: '2026-07-25T08:00:00.000Z',
      channels: [
        { id: 'channel-general', repositoryId: 'repository-1', name: 'general', createdAt: '2026-07-25T08:00:00.000Z' },
        { id: 'channel-build', repositoryId: 'repository-1', name: 'build', createdAt: '2026-07-25T08:00:00.000Z' },
      ],
      tasks: [{
        id: 'task-1', repositoryId: 'repository-1', channelId: 'channel-build', directAgentId: null, title: '修复频道界面', description: '描述',
        acceptanceCriteria: '通过测试', labels: ['frontend'], status: 'running', queuedAt: '2026-07-25T08:00:00.000Z', attemptCount: 1,
        maxRetries: 2, timeoutMs: 3_600_000, leaseTtlMs: null, branchName: 'task/task-1', worktreePath: '/tmp/task-1',
        createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
      }],
    }],
    recentMessages: [
      { id: 'message-1', channelId: 'channel-general', taskId: null, senderType: 'human', senderId: null, authorName: '你', body: '先看一下任务队列。', createdAt: '2026-07-25T08:01:00.000Z', updatedAt: '2026-07-25T08:01:00.000Z', deletedAt: null },
      { id: 'message-2', channelId: 'channel-build', taskId: 'task-1', senderType: 'agent', senderId: 'agent-1', authorName: '实现 Agent', body: '正在处理频道界面。', createdAt: '2026-07-25T08:02:00.000Z', updatedAt: '2026-07-25T08:02:00.000Z', deletedAt: null },
    ],
  }],
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null

  constructor(_url: string) { FakeEventSource.instances.push(this) }
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {}
  emit(type: string) { this.listeners.get(type)?.forEach((listener) => listener(new Event(type))) }
  open() { this.onopen?.(new Event('open')) }
}

function makeApi(overrides: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    getBootstrap: vi.fn().mockResolvedValue(snapshot),
    createWorkspace: vi.fn(),
    addRepository: vi.fn(),
    createAgent: vi.fn(),
    refreshAgentRuntime: vi.fn(),
    updateAgentResponsibilities: vi.fn().mockResolvedValue(snapshot.workspaces[0]!.agents[0]!),
    postMessage: vi.fn().mockResolvedValue(undefined),
    createChannel: vi.fn(),
    archiveChannel: vi.fn(),
    restoreChannel: vi.fn(),
    createTask: vi.fn(),
    getTaskDetails: vi.fn().mockResolvedValue(createdTaskDetails),
    queueTaskInput: vi.fn(),
    reviewTask: vi.fn(),
    requeueTask: vi.fn(),
    readArtifact: vi.fn(),
    ...overrides,
  }
}

const createdTask: TaskView = {
  id: 'task-new', repositoryId: 'repository-1', channelId: 'channel-general', directAgentId: 'agent-1', title: '补齐任务详情', description: '将任务面板接入工作台。',
  acceptanceCriteria: '可以查看证据并人工验收。', labels: ['frontend'], status: 'in_review', queuedAt: '2026-07-25T09:00:00.000Z', attemptCount: 1,
  maxRetries: 2, timeoutMs: 3_600_000, leaseTtlMs: null, branchName: 'task/task-new', worktreePath: '/tmp/task-new',
  createdAt: '2026-07-25T09:00:00.000Z', updatedAt: '2026-07-25T09:00:00.000Z',
}

const createdTaskDetails: TaskDetailView = {
  task: createdTask,
  sessions: [],
  leases: [],
  inputs: [],
  decisions: [],
  artifacts: [{ id: 'artifact-1', taskId: 'task-new', kind: 'test-results', createdAt: '2026-07-25T09:01:00.000Z' }],
  events: [],
}

describe('WorkspaceShell', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    window.localStorage.clear()
  })

  it('shows workspace creation when no workspace exists', async () => {
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue({ workspaces: [] }) })
    render(<WorkspaceShell api={api} />)

    expect(await screen.findByRole('heading', { name: '创建工作空间' })).toBeInTheDocument()
    expect(screen.getByLabelText('工作空间名称')).toBeInTheDocument()
    expect(screen.getByLabelText('工作目录')).toBeInTheDocument()
  })

  it('shows workspace channels and loads the selected channel messages', async () => {
    render(<WorkspaceShell api={makeApi()} />)

    expect(await screen.findByRole('button', { name: '# general' })).toBeInTheDocument()
    expect(screen.getAllByText('Sinapsis').length).toBeGreaterThan(0)
    expect(screen.getByText('先看一下任务队列。')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: '# build' }))
    expect(screen.getByText('正在处理频道界面。')).toBeInTheDocument()
    expect(screen.queryByText('先看一下任务队列。')).not.toBeInTheDocument()
  })

  it('switches the workspace context to the selected channel owner', async () => {
    const multiWorkspaceSnapshot = structuredClone(snapshot)
    const releaseWorkspace = structuredClone(snapshot.workspaces[0])
    releaseWorkspace.id = 'workspace-2'
    releaseWorkspace.name = 'Release'
    releaseWorkspace.agents = [{ ...releaseWorkspace.agents[0], id: 'agent-2', workspaceId: 'workspace-2', identity: '发布 Agent' }]
    releaseWorkspace.repositories[0].id = 'repository-2'
    releaseWorkspace.repositories[0].workspaceId = 'workspace-2'
    releaseWorkspace.repositories[0].name = 'release'
    releaseWorkspace.repositories[0].channels = [{ ...releaseWorkspace.repositories[0].channels[0], id: 'channel-release', repositoryId: 'repository-2', name: 'release' }]
    releaseWorkspace.repositories[0].tasks = []
    releaseWorkspace.recentMessages = [{ ...releaseWorkspace.recentMessages[0], id: 'message-release', channelId: 'channel-release', body: '这是 Release 工作空间的频道。' }]
    multiWorkspaceSnapshot.workspaces.push(releaseWorkspace)
    const user = userEvent.setup()

    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(multiWorkspaceSnapshot) })} />)

    await user.click(await screen.findByRole('button', { name: '# release' }))

    expect(screen.getByText('这是 Release 工作空间的频道。')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '当前频道工作空间：Release' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '当前频道工作空间：Sinapsis' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看 发布 Agent 配置' })).toBeInTheDocument()
  })

  it('moves archived channels into a collapsible read-only folder', async () => {
    const archivedSnapshot = structuredClone(snapshot)
    archivedSnapshot.workspaces[0].repositories[0].channels[1].archivedAt = '2026-07-28T08:00:00.000Z'
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(archivedSnapshot) })} />)

    await screen.findByRole('button', { name: '# general' })
    expect(screen.queryByRole('button', { name: '# build' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '已归档频道（1）' }))
    await user.click(screen.getByRole('button', { name: '# build' }))

    expect(screen.getByText('此频道已归档，只能查看历史记录。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '发送消息' })).not.toBeInTheDocument()
  })

  it('archives and restores channels from their sidebar controls', async () => {
    const archivedSnapshot = structuredClone(snapshot)
    archivedSnapshot.workspaces[0].repositories[0].channels[1].archivedAt = '2026-07-28T08:00:00.000Z'
    const api = makeApi({
      archiveChannel: vi.fn().mockResolvedValue(archivedSnapshot.workspaces[0].repositories[0].channels[1]),
      restoreChannel: vi.fn().mockResolvedValue(snapshot.workspaces[0].repositories[0].channels[1]),
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(archivedSnapshot).mockResolvedValueOnce(snapshot),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '归档 # build' }))
    expect(api.archiveChannel).toHaveBeenCalledWith('channel-build')
    await user.click(await screen.findByRole('button', { name: '已归档频道（1）' }))
    await user.click(screen.getByRole('button', { name: '恢复 # build' }))

    expect(api.restoreChannel).toHaveBeenCalledWith('channel-build')
  })

  it('shows an archive failure without leaving an unhandled sidebar action', async () => {
    const api = makeApi({ archiveChannel: vi.fn().mockRejectedValue(new Error('频道仍有未完成任务。')) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '归档 # build' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('频道仍有未完成任务。')
  })

  it('orders channels before workspace selection and tasks in the sidebar', async () => {
    render(<WorkspaceShell api={makeApi()} />)

    await screen.findByRole('button', { name: '# general' })
    const navigation = document.querySelector<HTMLElement>('nav.repository-sidebar')!
    const children = Array.from(navigation.children)
    expect(children.findIndex((child) => child.classList.contains('sidebar-channel-heading'))).toBeLessThan(children.findIndex((child) => child.classList.contains('sidebar-topline')))
    expect(children.findIndex((child) => child.classList.contains('sidebar-topline'))).toBeLessThan(children.findIndex((child) => child.classList.contains('workspace-task-list')))
  })

  it('restores the last selected workspace channel after a page refresh', async () => {
    window.localStorage.setItem('sinapsis:workspace-selection', JSON.stringify({ workspaceId: 'workspace-1', channelId: 'channel-build' }))
    render(<WorkspaceShell api={makeApi()} />)

    expect(await screen.findByText('正在处理频道界面。')).toBeInTheDocument()
    expect(screen.queryByText('先看一下任务队列。')).not.toBeInTheDocument()
  })

  it('keeps the workspace dialog open when its bootstrap refresh fails', async () => {
    const createdWorkspace = { id: 'workspace-2', name: 'Release', leaseTtlMs: 30_000, createdAt: '2026-07-25T10:00:00.000Z' }
    const api = makeApi({
      createWorkspace: vi.fn().mockResolvedValue(createdWorkspace),
      addRepository: vi.fn().mockResolvedValue(undefined),
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('刷新失败')),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '添加工作空间' }))
    const dialog = screen.getByRole('dialog', { name: '添加本地工作目录' })
    await user.type(within(dialog).getByLabelText('工作空间名称'), 'Release')
    await user.type(within(dialog).getByLabelText('工作目录'), '/code/release')
    await user.click(within(dialog).getByRole('button', { name: '添加工作空间' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByRole('dialog', { name: '添加本地工作目录' })).toBeInTheDocument()
  })

  it('posts ordinary messages to the selected channel', async () => {
    const api = makeApi()
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('textbox', { name: '发送消息' })
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '大家同步一下。')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    expect(api.postMessage).toHaveBeenCalledWith('channel-general', { body: '大家同步一下。' })
  })

  it('opens a Thread and sends replies under its root message', async () => {
    const threadedSnapshot = structuredClone(snapshot)
    threadedSnapshot.workspaces[0].recentMessages.push({
      id: 'message-reply', channelId: 'channel-general', threadRootMessageId: 'message-1', taskId: null, senderType: 'agent', senderId: 'agent-1', authorName: '实现 Agent', body: '我会跟进。',
      createdAt: '2026-07-25T08:03:00.000Z', updatedAt: '2026-07-25T08:03:00.000Z', deletedAt: null,
    })
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue(threadedSnapshot) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '回复 你 的消息' }))
    const thread = screen.getByRole('region', { name: 'Thread' })
    expect(thread).toHaveTextContent('我会跟进。')
    await user.type(within(thread).getByRole('textbox', { name: '发送消息' }), '继续跟进。')
    await user.click(within(thread).getByRole('button', { name: '发送消息' }))

    expect(api.postMessage).toHaveBeenCalledWith('channel-general', { body: '继续跟进。', threadRootMessageId: 'message-1' })
  })

  it('creates a channel from the sidebar and selects it', async () => {
    const createdChannel = { id: 'channel-release', repositoryId: 'repository-1', name: 'release', createdAt: '2026-07-25T10:00:00.000Z' }
    const updated = structuredClone(snapshot)
    updated.workspaces[0].repositories[0].channels.push(createdChannel)
    const api = makeApi({
      createChannel: vi.fn().mockResolvedValue(createdChannel),
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(updated),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('button', { name: '添加频道' })
    await user.click(screen.getByRole('button', { name: '添加频道' }))
    await user.type(screen.getByLabelText('频道名称'), 'release')
    await user.click(screen.getByRole('button', { name: '创建频道' }))

    expect(api.createChannel).toHaveBeenCalledWith('repository-1', { name: 'release' })
    expect(await screen.findByRole('heading', { name: '# release' })).toBeInTheDocument()
  })

  it('keeps the channel dialog open when its post-create refresh fails', async () => {
    const createdChannel = { id: 'channel-release', repositoryId: 'repository-1', name: 'release', createdAt: '2026-07-25T10:00:00.000Z' }
    const api = makeApi({
      createChannel: vi.fn().mockResolvedValue(createdChannel),
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('刷新失败')),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '添加频道' }))
    await user.type(screen.getByLabelText('频道名称'), 'release')
    await user.click(screen.getByRole('button', { name: '创建频道' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByRole('dialog', { name: '添加频道' })).toBeInTheDocument()
  })

  it('dispatches /task commands to # build instead of posting a message', async () => {
    const task = { ...createdTask, title: '修复导航', description: '修复导航', acceptanceCriteria: '任务完成后在当前频道说明结果。', channelId: 'channel-build' }
    const api = makeApi({ createTask: vi.fn().mockResolvedValue(task) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('textbox', { name: '发送消息' })
    await user.click(screen.getByRole('button', { name: '# build' }))
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '/task @builder 修复导航')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    expect(api.createTask).toHaveBeenCalledWith('repository-1', {
      title: '修复导航',
      description: '修复导航',
      acceptanceCriteria: '任务完成后在当前频道说明结果。',
      labels: [],
      directAgentId: 'agent-1',
      channelId: 'channel-build',
    })
    expect(api.postMessage).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('任务已派发。')
  })

  it('keeps task dispatch visibly failed when its post-create refresh fails', async () => {
    const api = makeApi({
      createTask: vi.fn().mockResolvedValue(createdTask),
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('刷新失败')),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    const composer = await screen.findByRole('textbox', { name: '发送消息' })
    await user.type(composer, '/task @builder 修复导航')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(composer).toHaveValue('/task @builder 修复导航')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('loads details for the initially selected channel task', async () => {
    const initialTask = { ...createdTask, channelId: 'channel-general', status: 'queued' as const }
    const initialDetails = { ...createdTaskDetails, task: initialTask }
    const initialSnapshot = structuredClone(snapshot)
    initialSnapshot.workspaces[0].repositories[0].tasks = [initialTask]
    const refreshedSnapshot = structuredClone(initialSnapshot)
    const api = makeApi({
      getBootstrap: vi.fn().mockResolvedValueOnce(initialSnapshot).mockResolvedValueOnce(refreshedSnapshot),
      getTaskDetails: vi.fn().mockResolvedValue(initialDetails),
    })

    render(<WorkspaceShell api={api} />)

    expect(await screen.findByRole('heading', { name: '概览' })).toBeInTheDocument()
    expect(api.getTaskDetails).toHaveBeenCalledWith('task-new')
  })

  it('creates an Agent from the workspace sidebar', async () => {
    const api = makeApi({ createAgent: vi.fn().mockResolvedValue(snapshot.workspaces[0].agents[0]) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('button', { name: '添加 Agent' })
    await user.click(screen.getByRole('button', { name: '添加 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '添加 Agent' })
    await user.type(within(dialog).getByLabelText('Agent 名称'), '验证 Agent')
    await user.type(within(dialog).getByLabelText('能力标签'), 'typescript, test')
    await user.click(within(dialog).getByRole('button', { name: '添加 Agent' }))

    expect(api.createAgent).toHaveBeenCalledWith('workspace-1', {
      identity: '验证 Agent', mention: '验证-agent', runtime: 'opencode', capabilityTags: ['typescript', 'test'], responsibilities: [],
    })
  })

  it('allows selecting Claude Code when creating an Agent', async () => {
    const api = makeApi({ createAgent: vi.fn().mockResolvedValue(snapshot.workspaces[0].agents[0]) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('button', { name: '添加 Agent' })
    await user.click(screen.getByRole('button', { name: '添加 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '添加 Agent' })

    await user.type(within(dialog).getByLabelText('Agent 名称'), 'Claude Agent')
    await user.selectOptions(within(dialog).getByLabelText('Runtime'), 'claude-code')
    await user.type(within(dialog).getByLabelText('能力标签'), 'review')
    await user.click(within(dialog).getByRole('button', { name: '添加 Agent' }))

    expect(api.createAgent).toHaveBeenCalledWith('workspace-1', {
      identity: 'Claude Agent', mention: 'claude-agent', runtime: 'claude-code', capabilityTags: ['review'], responsibilities: [],
    })
  })

  it('shows Claude Code runtime copy in the agent config dialog', async () => {
    const claudeSnapshot = structuredClone(snapshot)
    claudeSnapshot.workspaces[0].agents[0].runtime = 'claude-code'
    claudeSnapshot.workspaces[0].agents[0].model = ''

    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(claudeSnapshot) })} />)
    const user = userEvent.setup()

    await screen.findByRole('button', { name: '查看 实现 Agent 配置' })
    await user.click(screen.getByRole('button', { name: '查看 实现 Agent 配置' }))

    expect(screen.getByText('Claude Code CLI 受管运行')).toBeInTheDocument()
    expect(screen.getByText('使用 Claude Code 默认值')).toBeInTheDocument()
  })

  it('rechecks an agent runtime from the config dialog and refreshes bootstrap afterwards', async () => {
    let releaseRefresh: (() => void) | undefined
    const refreshAgentRuntime = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { releaseRefresh = resolve }))
    const api = makeApi({
      getBootstrap: vi.fn().mockResolvedValue(snapshot),
      refreshAgentRuntime,
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('button', { name: '查看 实现 Agent 配置' })
    await user.click(screen.getByRole('button', { name: '查看 实现 Agent 配置' }))

    const recheckButton = screen.getByRole('button', { name: '重新检测 Agent Runtime' })
    expect(recheckButton).toHaveAttribute('data-tooltip', '重新检测 Agent Runtime')

    await user.click(recheckButton)

    expect(api.refreshAgentRuntime).toHaveBeenCalledWith('agent-1')
    expect(recheckButton).toBeDisabled()

    releaseRefresh?.()

    expect(await screen.findByRole('button', { name: '重新检测 Agent Runtime' })).toBeEnabled()
    expect(api.getBootstrap).toHaveBeenCalledTimes(2)
  })

  it('keeps the agent config dialog usable when its bootstrap refresh fails', async () => {
    const api = makeApi({
      refreshAgentRuntime: vi.fn().mockResolvedValue(undefined),
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('刷新失败')),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '查看 实现 Agent 配置' }))
    await user.click(screen.getByRole('button', { name: '重新检测 Agent Runtime' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败')
    expect(screen.getByRole('dialog', { name: '实现 Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新检测 Agent Runtime' })).toBeEnabled()
  })

  it('refreshes the snapshot and agent status after a task.status_changed event', async () => {
    const updated = structuredClone(snapshot)
    updated.workspaces[0].agents[0].status = 'busy'
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(updated) })
    render(<WorkspaceShell api={api} />)

    await screen.findByText('空闲')
    FakeEventSource.instances[0].emit('task.status_changed')

    expect(await screen.findByText('忙碌')).toBeInTheDocument()
    expect(api.getBootstrap).toHaveBeenCalledTimes(2)
  })

  it('refreshes the opened task detail after a runtime artifact event', async () => {
    const initialTask = { ...createdTask, channelId: 'channel-general', status: 'running' as const }
    const initialSnapshot = structuredClone(snapshot)
    initialSnapshot.workspaces[0].repositories[0].tasks = [initialTask]
    const updatedDetails = {
      ...createdTaskDetails,
      task: initialTask,
      events: [{ id: 'event-1', taskId: initialTask.id, type: 'runtime.text', payload: { text: '正在运行。' }, createdAt: '2026-07-25T09:02:00.000Z' }],
    }
    const refreshedSnapshot = structuredClone(initialSnapshot)
    const api = makeApi({
      getBootstrap: vi.fn().mockResolvedValueOnce(initialSnapshot).mockResolvedValueOnce(refreshedSnapshot),
      getTaskDetails: vi.fn().mockResolvedValueOnce({ ...createdTaskDetails, task: initialTask }).mockResolvedValueOnce(updatedDetails),
    })
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('heading', { name: '概览' })
    FakeEventSource.instances[0].emit('task.artifact_created')

    expect(await screen.findByLabelText('Agent 实时输出')).toHaveTextContent('正在运行。')
  })

  it('refreshes the bootstrap snapshot after the event stream reconnects without a domain event', async () => {
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue(snapshot) })
    render(<WorkspaceShell api={api} />)

    await screen.findByText('已连接')
    FakeEventSource.instances[0].onerror?.(new Event('error'))
    expect(await screen.findByText('正在重新连接')).toBeInTheDocument()

    FakeEventSource.instances[0].open()
    expect(await screen.findByText('已连接')).toBeInTheDocument()
    expect(api.getBootstrap).toHaveBeenCalledTimes(2)
  })

  it('shows each workspace task inside its owning channel', async () => {
    render(<WorkspaceShell api={makeApi()} />)
    const user = userEvent.setup()

    await screen.findByRole('button', { name: '# general' })
    expect(screen.queryByRole('button', { name: '修复频道界面' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '# build' }))
    await screen.findByRole('button', { name: '修复频道界面' })
    await user.click(screen.getByRole('button', { name: '修复频道界面' }))

    expect(await screen.findByRole('heading', { name: '概览' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '# build' })).toBeInTheDocument()
  })

  it('keeps the message area usable while narrow-screen drawers are closed', async () => {
    render(<WorkspaceShell api={makeApi()} />)
    const user = userEvent.setup()

    await screen.findByRole('textbox', { name: '发送消息' })
    await user.click(screen.getByRole('button', { name: '打开导航' }))
    expect(screen.getByRole('navigation', { name: '工作空间' })).toHaveAttribute('data-mobile-open', 'true')
    await user.click(screen.getByRole('button', { name: '关闭导航' }))

    expect(screen.getByRole('textbox', { name: '发送消息' })).toBeEnabled()
    expect(within(screen.getByRole('main')).getByText('先看一下任务队列。')).toBeInTheDocument()
  })

  it('removes narrow-screen drawers from the accessibility tree until opened', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('700px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    try {
      render(<WorkspaceShell api={makeApi()} />)
      const user = userEvent.setup()

      await screen.findByRole('textbox', { name: '发送消息' })
      const navigation = document.querySelector<HTMLElement>('nav[aria-label="工作空间"]')
      expect(navigation).not.toBeNull()
      expect(navigation).toHaveAttribute('aria-hidden', 'true')
      expect(navigation).toHaveAttribute('inert')

      await user.click(screen.getByRole('button', { name: '打开导航' }))
      expect(navigation!).not.toHaveAttribute('aria-hidden')
      expect(navigation!).not.toHaveAttribute('inert')
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('shows a composer error when sending a message fails', async () => {
    const api = makeApi({ postMessage: vi.fn().mockRejectedValue(new Error('本机服务不可用')) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    const composer = await screen.findByRole('textbox', { name: '发送消息' })
    await user.type(composer, '这条消息发送失败。')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('本机服务不可用')
    expect(composer).toHaveValue('这条消息发送失败。')
  })

  it('creates a repository-bound task and opens its evidence and review details', async () => {
    const updated = structuredClone(snapshot)
    updated.workspaces[0].repositories[0].tasks.push(createdTask)
    const api = makeApi({
      getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(updated),
      createTask: vi.fn().mockResolvedValue(createdTask),
      getTaskDetails: vi.fn().mockResolvedValue(createdTaskDetails),
      readArtifact: vi.fn().mockResolvedValue('vitest: 12 passed'),
      reviewTask: vi.fn().mockResolvedValue({ ...createdTask, status: 'accepted' }),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await screen.findByRole('button', { name: '新建 Sinapsis 任务' })
    await user.click(screen.getByRole('button', { name: '新建 Sinapsis 任务' }))
    await user.type(screen.getByLabelText('任务标题'), createdTask.title)
    await user.type(screen.getByLabelText('详细描述'), createdTask.description)
    await user.type(screen.getByLabelText('验收标准'), createdTask.acceptanceCriteria)
    await user.type(screen.getByLabelText('标签'), 'frontend')
    await user.selectOptions(screen.getByLabelText('指定 Agent'), 'agent-1')
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    expect(api.createTask).toHaveBeenCalledWith('repository-1', {
      title: createdTask.title,
      description: createdTask.description,
      acceptanceCriteria: createdTask.acceptanceCriteria,
      labels: ['frontend'],
      directAgentId: 'agent-1',
      channelId: 'channel-general',
    })
    expect(await screen.findByRole('heading', { name: '概览' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'test-results' }))
    expect(await screen.findByLabelText('运行证据内容')).toHaveTextContent('vitest: 12 passed')
    await user.click(screen.getByRole('button', { name: '接受验收' }))
    expect(api.reviewTask).toHaveBeenCalledWith('task-new', 'accept', expect.any(String))
    expect(await screen.findByText('验收已通过，尚未合并')).toBeInTheDocument()
  })
})
