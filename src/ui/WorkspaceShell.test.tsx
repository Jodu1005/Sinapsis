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
    postMessage: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn(),
    getTaskDetails: vi.fn().mockResolvedValue(createdTaskDetails),
    queueTaskInput: vi.fn(),
    reviewTask: vi.fn(),
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
  })

  it('shows workspace creation when no workspace exists', async () => {
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue({ workspaces: [] }) })
    render(<WorkspaceShell api={api} />)

    expect(await screen.findByRole('heading', { name: '创建工作空间' })).toBeInTheDocument()
    expect(screen.getByLabelText('工作空间名称')).toBeInTheDocument()
    expect(screen.getByLabelText('代码仓路径')).toBeInTheDocument()
  })

  it('groups channels by repository and loads the selected channel messages', async () => {
    render(<WorkspaceShell api={makeApi()} />)

    expect(await screen.findByRole('button', { name: '# general' })).toBeInTheDocument()
    expect(screen.getByText('sinapsis')).toBeInTheDocument()
    expect(screen.getByText('先看一下任务队列。')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: '# build' }))
    expect(screen.getByText('正在处理频道界面。')).toBeInTheDocument()
    expect(screen.queryByText('先看一下任务队列。')).not.toBeInTheDocument()
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
    await user.type(within(dialog).getByLabelText('提及名'), 'verify')
    await user.type(within(dialog).getByLabelText('能力标签'), 'typescript, test')
    await user.click(within(dialog).getByRole('button', { name: '添加 Agent' }))

    expect(api.createAgent).toHaveBeenCalledWith('workspace-1', {
      identity: '验证 Agent', mention: 'verify', runtime: 'opencode', capabilityTags: ['typescript', 'test'],
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
    await user.type(within(dialog).getByLabelText('提及名'), 'claude')
    await user.selectOptions(within(dialog).getByLabelText('Runtime'), 'claude-code')
    await user.type(within(dialog).getByLabelText('能力标签'), 'review')
    await user.click(within(dialog).getByRole('button', { name: '添加 Agent' }))

    expect(api.createAgent).toHaveBeenCalledWith('workspace-1', {
      identity: 'Claude Agent', mention: 'claude', runtime: 'claude-code', capabilityTags: ['review'],
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

  it('refreshes the snapshot and agent status after a task.changed event', async () => {
    const updated = structuredClone(snapshot)
    updated.workspaces[0].agents[0].status = 'busy'
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(updated) })
    render(<WorkspaceShell api={api} />)

    await screen.findByText('空闲')
    FakeEventSource.instances[0].emit('task.changed')

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

  it('opens the selected repository task list without selecting an arbitrary channel', async () => {
    render(<WorkspaceShell api={makeApi()} />)
    const user = userEvent.setup()

    await screen.findByRole('button', { name: '任务 1' })
    await user.click(screen.getByRole('button', { name: '任务 1' }))

    expect(screen.getByRole('heading', { name: 'sinapsis 任务' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '执行中' }))
    expect(screen.getByRole('button', { name: /修复频道界面/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '# general' })).toBeInTheDocument()
  })

  it('keeps the message area usable while narrow-screen drawers are closed', async () => {
    render(<WorkspaceShell api={makeApi()} />)
    const user = userEvent.setup()

    await screen.findByRole('textbox', { name: '发送消息' })
    await user.click(screen.getByRole('button', { name: '打开导航' }))
    expect(screen.getByRole('navigation', { name: '代码仓与频道' })).toHaveAttribute('data-mobile-open', 'true')
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
      const navigation = document.querySelector<HTMLElement>('nav[aria-label="代码仓与频道"]')
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

    await screen.findByRole('button', { name: '新建 sinapsis 任务' })
    await user.click(screen.getByRole('button', { name: '新建 sinapsis 任务' }))
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
    })
    expect(await screen.findByRole('heading', { name: '概览' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'test-results' }))
    expect(await screen.findByLabelText('运行证据内容')).toHaveTextContent('vitest: 12 passed')
    await user.click(screen.getByRole('button', { name: '接受验收' }))
    expect(api.reviewTask).toHaveBeenCalledWith('task-new', 'accept', expect.any(String))
    expect(await screen.findByText('验收已通过，尚未合并')).toBeInTheDocument()
  })
})
