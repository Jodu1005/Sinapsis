import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, type WorkspaceApi } from '../api/client'
import type { ConversationTurnDetailView, MemoryCandidateView, TaskDetailView, TaskView, WorkspaceSnapshot } from '../domain/workspace-view'
import { WorkspaceShell } from './WorkspaceShell'

const snapshot: WorkspaceSnapshot = {
  agents: [{
    id: 'agent-1', identity: '实现 Agent', mentionName: 'builder', runtime: 'opencode',
    status: 'idle', capabilityTags: ['frontend'], maxConcurrentTasks: 1, command: 'opencode', args: [], model: 'claude', env: [],
    createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
  }],
  channels: [
    { id: 'channel-general', name: 'general', systemKey: null, memberAgentIds: ['agent-1'], boundWorkspaceIds: ['workspace-1'], createdAt: '2026-07-25T08:00:00.000Z' },
    { id: 'channel-build', name: 'build', systemKey: null, memberAgentIds: ['agent-1'], boundWorkspaceIds: ['workspace-1'], createdAt: '2026-07-25T08:00:00.000Z' },
  ],
  workspaces: [{
    id: 'workspace-1', name: 'Sinapsis', leaseTtlMs: 30_000, createdAt: '2026-07-25T08:00:00.000Z',
    repositories: [{
      id: 'repository-1', workspaceId: 'workspace-1', name: 'sinapsis', path: '/code/sinapsis', currentBranch: 'main', defaultBranch: 'main', isClean: true,
      createdAt: '2026-07-25T08:00:00.000Z',
    }],
  }],
  tasks: [{
    id: 'task-1', workspaceId: 'workspace-1', repositoryId: 'repository-1', channelId: 'channel-build', directAgentId: null, title: '修复频道界面', description: '描述',
    acceptanceCriteria: '通过测试', labels: ['frontend'], status: 'running', queuedAt: '2026-07-25T08:00:00.000Z', attemptCount: 1,
    maxRetries: 2, timeoutMs: 3_600_000, leaseTtlMs: null, branchName: 'task/task-1', worktreePath: '/tmp/task-1',
    createdAt: '2026-07-25T08:00:00.000Z', updatedAt: '2026-07-25T08:00:00.000Z',
  }],
  recentMessages: [
    { id: 'message-1', channelId: 'channel-general', taskId: null, senderType: 'human', senderId: null, authorName: '你', body: '先看一下任务队列。', createdAt: '2026-07-25T08:01:00.000Z', updatedAt: '2026-07-25T08:01:00.000Z', deletedAt: null },
    { id: 'message-2', channelId: 'channel-build', taskId: 'task-1', senderType: 'agent', senderId: 'agent-1', authorName: '实现 Agent', body: '正在处理频道界面。', createdAt: '2026-07-25T08:02:00.000Z', updatedAt: '2026-07-25T08:02:00.000Z', deletedAt: null },
  ],
  maxWorkspaceBindingsPerChannel: 5,
  pendingMemoryCandidateCount: 0,
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
    updateAgentResponsibilities: vi.fn().mockResolvedValue(snapshot.agents[0]!),
    postMessage: vi.fn().mockResolvedValue(undefined),
    getChannelMessage: vi.fn(),
    createChannel: vi.fn(),
    archiveChannel: vi.fn(),
    restoreChannel: vi.fn(),
    resetChannelContext: vi.fn(),
    addChannelAgent: vi.fn(),
    removeChannelAgent: vi.fn(),
    bindChannelWorkspace: vi.fn(),
    unbindChannelWorkspace: vi.fn(),
    createTask: vi.fn(),
    getTaskDetails: vi.fn().mockResolvedValue(createdTaskDetails),
    queueTaskInput: vi.fn(),
    reviewTask: vi.fn(),
    requeueTask: vi.fn(),
    getConversationTurn: vi.fn(),
    cancelConversationTurn: vi.fn(),
    readArtifact: vi.fn(),
    listDreamRuns: vi.fn().mockResolvedValue([]),
    startDream: vi.fn().mockResolvedValue([]),
    listMemoryCandidates: vi.fn().mockResolvedValue([]),
    acceptMemoryCandidate: vi.fn(),
    ignoreMemoryCandidate: vi.fn(),
    listMemories: vi.fn().mockResolvedValue([]),
    updateMemory: vi.fn(),
    archiveMemory: vi.fn(),
    ...overrides,
  }
}

const createdTask: TaskView = {
  id: 'task-new', workspaceId: 'workspace-1', repositoryId: 'repository-1', channelId: 'channel-general', directAgentId: 'agent-1', title: '补齐任务详情', description: '将任务面板接入工作台。',
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

const turnDetail: ConversationTurnDetailView = {
  turn: {
    id: 'turn-1',
    channelId: 'channel-general',
    triggerMessageId: 'message-1',
    threadRootMessageId: null,
    mode: 'ordinary',
    status: 'responding',
    currentRound: 1,
    maxRounds: 3,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:01:00.000Z',
    completedAt: null,
  },
  participants: [{
    id: 'participant-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    source: 'responsibility',
    rank: 0,
    matcherScore: 18,
    decision: 'speak',
    confidence: 0.88,
    proposedAngle: '检查频道状态渲染',
    dependsOnAgentId: null,
    speakingOrder: 1,
    status: 'selected',
    reason: '职责命中 frontend',
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:01:00.000Z',
  }],
  invocations: [{
    id: 'invocation-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    kind: 'response',
    priority: 'human_ordinary',
    round: 1,
    status: 'running',
    sourceInvocationId: null,
    queuedAt: '2026-07-31T08:00:00.000Z',
    startedAt: '2026-07-31T08:01:00.000Z',
    completedAt: null,
    errorCategory: null,
  }],
  handoffs: [],
}

const dreamCandidate: MemoryCandidateView = {
  id: 'candidate-1', dreamRunId: 'run-1', proposedScope: 'channel', channelId: 'channel-general', kind: 'fact',
  proposedContent: 'React 是前端标准。', rationale: '多次确认。', confidence: 0.9, importance: 0.8, status: 'pending',
  reviewedContent: null, reviewedScope: null, reviewedChannelId: null, reviewedAt: null, createdAt: '2026-08-01T08:00:00.000Z',
  sources: [{ channelId: 'channel-general', channelName: 'general', messageId: 'message-1', threadRootMessageId: null }], sourceMessageCount: 1,
}

describe('WorkspaceShell', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    window.localStorage.clear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows workspace creation when no workspace exists', async () => {
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue({ ...snapshot, workspaces: [] }) })
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

  it('keeps the persisted channel selection while Dream Center is open and returns to a source message channel', async () => {
    window.localStorage.setItem('sinapsis:workspace-selection', JSON.stringify({ channelId: 'channel-build' }))
    const dreamSnapshot = { ...snapshot, pendingMemoryCandidateCount: 1 }
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(dreamSnapshot), listMemoryCandidates: vi.fn().mockResolvedValue([dreamCandidate]), getChannelMessage: vi.fn().mockResolvedValue({ message: snapshot.recentMessages[0], threadRoot: null }) })} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Dream（1 个待确认）' }))

    expect(await screen.findByRole('heading', { name: 'Dream Center' })).toBeInTheDocument()
    expect(window.localStorage.getItem('sinapsis:workspace-selection')).toBe(JSON.stringify({ channelId: 'channel-build' }))
    await userEvent.setup().click(screen.getByRole('button', { name: '跳转到 # general 的来源消息' }))

    expect(await screen.findByRole('heading', { name: '# general' })).toBeInTheDocument()
    expect(screen.getByText('先看一下任务队列。')).toBeInTheDocument()
    expect(window.localStorage.getItem('sinapsis:workspace-selection')).toBe(JSON.stringify({ channelId: 'channel-general' }))
  })

  it('fetches an old reply source, focuses its Timeline root, and opens its Thread', async () => {
    const oldRoot = { id: 'message-old-root', channelId: 'channel-general', taskId: null, senderType: 'human' as const, senderId: null, authorName: '你', body: '旧 Thread 根消息。', createdAt: '2026-07-20T08:00:00.000Z', updatedAt: '2026-07-20T08:00:00.000Z', deletedAt: null }
    const oldReply = { id: 'message-old-reply', channelId: 'channel-general', threadRootMessageId: oldRoot.id, taskId: null, senderType: 'agent' as const, senderId: 'agent-1', authorName: '实现 Agent', body: '旧 Thread 回复。', createdAt: '2026-07-20T08:01:00.000Z', updatedAt: '2026-07-20T08:01:00.000Z', deletedAt: null }
    const oldCandidate = { ...dreamCandidate, sources: [
      { channelId: 'channel-general', channelName: 'general', messageId: oldRoot.id, threadRootMessageId: null },
      { channelId: 'channel-general', channelName: 'general', messageId: oldReply.id, threadRootMessageId: oldRoot.id },
    ], sourceMessageCount: 2 }
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue({ ...snapshot, pendingMemoryCandidateCount: 1 }), listMemoryCandidates: vi.fn().mockResolvedValue([oldCandidate]) }) as WorkspaceApi & { getChannelMessage: ReturnType<typeof vi.fn> }
    api.getChannelMessage = vi.fn()
      .mockResolvedValueOnce({ message: oldRoot, threadRoot: null })
      .mockResolvedValueOnce({ message: oldReply, threadRoot: oldRoot })
    render(<WorkspaceShell api={api} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Dream（1 个待确认）' }))
    await userEvent.setup().click(await screen.findByRole('button', { name: '跳转到 # general 的来源消息' }))

    expect((await screen.findAllByText('旧 Thread 根消息。')).length).toBeGreaterThan(0)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dream（1 个待确认）' }))
    await userEvent.setup().click(await screen.findByRole('button', { name: '跳转到 # general 的来源消息 2' }))
    expect(await screen.findByText('旧 Thread 回复。')).toBeInTheDocument()
    expect(api.getChannelMessage).toHaveBeenNthCalledWith(1, 'channel-general', oldRoot.id)
    expect(api.getChannelMessage).toHaveBeenNthCalledWith(2, 'channel-general', oldReply.id)
  })

  it('keeps a mobile navigation toggle available in Dream Center', async () => {
    const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
    try {
      render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue({ ...snapshot, pendingMemoryCandidateCount: 1 }) })} />)
      await userEvent.setup().click(await screen.findByRole('button', { name: '打开导航' }))
      await userEvent.setup().click(screen.getByRole('button', { name: 'Dream（1 个待确认）' }))

      await userEvent.setup().click(screen.getByRole('button', { name: '打开导航' }))
      expect(screen.getByRole('navigation', { name: '工作空间', hidden: true })).toHaveAttribute('data-mobile-open', 'true')
    } finally {
      if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia)
      else delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia
    }
  })

  it('shows only the workspaces bound to the selected channel', async () => {
    const multiWorkspaceSnapshot = structuredClone(snapshot)
    const releaseWorkspace = structuredClone(snapshot.workspaces[0])
    releaseWorkspace.id = 'workspace-2'
    releaseWorkspace.name = 'Release'
    releaseWorkspace.repositories[0].id = 'repository-2'
    releaseWorkspace.repositories[0].workspaceId = 'workspace-2'
    releaseWorkspace.repositories[0].name = 'release'
    multiWorkspaceSnapshot.workspaces.push(releaseWorkspace)
    multiWorkspaceSnapshot.workspaces.push({
      ...releaseWorkspace,
      id: 'workspace-unbound',
      name: 'Unbound Workspace',
      repositories: [{ ...releaseWorkspace.repositories[0], id: 'repository-unbound', workspaceId: 'workspace-unbound' }],
    })
    multiWorkspaceSnapshot.agents.push({ ...multiWorkspaceSnapshot.agents[0], id: 'agent-2', identity: '发布 Agent' })
    multiWorkspaceSnapshot.channels.push({ ...multiWorkspaceSnapshot.channels[0], id: 'channel-release', name: 'release', memberAgentIds: ['agent-2'], boundWorkspaceIds: ['workspace-1', 'workspace-2'] })
    multiWorkspaceSnapshot.recentMessages.push({ ...multiWorkspaceSnapshot.recentMessages[0], id: 'message-release', channelId: 'channel-release', body: '这是 Release 工作空间的频道。' })
    const user = userEvent.setup()

    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(multiWorkspaceSnapshot) })} />)

    await user.click(await screen.findByRole('button', { name: '# release' }))

    expect(screen.getByText('这是 Release 工作空间的频道。')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'release 的工作空间' })).toHaveTextContent('Sinapsis')
    expect(screen.getByRole('group', { name: 'release 的工作空间' })).toHaveTextContent('Release')
    expect(screen.queryByText('Unbound Workspace')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看 发布 Agent 配置' })).toBeInTheDocument()
  })

  it('moves archived channels into a collapsible read-only folder', async () => {
    const archivedSnapshot = structuredClone(snapshot)
    archivedSnapshot.channels[1].archivedAt = '2026-07-28T08:00:00.000Z'
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
    archivedSnapshot.channels[1].archivedAt = '2026-07-28T08:00:00.000Z'
    const api = makeApi({
      archiveChannel: vi.fn().mockResolvedValue(archivedSnapshot.channels[1]),
      restoreChannel: vi.fn().mockResolvedValue(snapshot.channels[1]),
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

  it('only presents and confirms context reset for the summit channel', async () => {
    const summitSnapshot = structuredClone(snapshot)
    summitSnapshot.channels[0].name = 'summit'
    summitSnapshot.channels[0].systemKey = 'summit'
    const clearedSnapshot = structuredClone(summitSnapshot)
    clearedSnapshot.tasks = []
    clearedSnapshot.recentMessages = []
    const resetChannelContext = vi.fn().mockResolvedValue({
      ...summitSnapshot.channels[0],
      contextResetAt: '2026-07-29T08:00:00.000Z',
    })
    const api = makeApi({
      resetChannelContext,
      getBootstrap: vi.fn().mockResolvedValueOnce(summitSnapshot).mockResolvedValueOnce(clearedSnapshot),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    expect(await screen.findByRole('button', { name: '清空频道上下文' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清空频道上下文' }))
    const dialog = screen.getByRole('dialog', { name: '清空 summit 上下文' })
    await user.click(within(dialog).getByRole('button', { name: '清空上下文' }))

    expect(resetChannelContext).toHaveBeenCalledWith('channel-general')
    expect(await screen.findByRole('heading', { name: '# summit' })).toBeInTheDocument()
    expect(screen.queryByText('先看一下任务队列。')).not.toBeInTheDocument()
  })

  it('does not offer context reset for a regular channel', async () => {
    render(<WorkspaceShell api={makeApi()} />)

    await screen.findByRole('heading', { name: '# general' })
    expect(screen.queryByRole('button', { name: '清空频道上下文' })).not.toBeInTheDocument()
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

  it('restores and persists only the selected channel after a page refresh', async () => {
    window.localStorage.setItem('sinapsis:workspace-selection', JSON.stringify({ channelId: 'channel-build' }))
    render(<WorkspaceShell api={makeApi()} />)

    expect(await screen.findByText('正在处理频道界面。')).toBeInTheDocument()
    expect(screen.queryByText('先看一下任务队列。')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: '# general' }))
    expect(JSON.parse(window.localStorage.getItem('sinapsis:workspace-selection')!)).toEqual({ channelId: 'channel-general' })
  })

  it('refreshes channel management while preserving the selected channel', async () => {
    const initialSnapshot = structuredClone(snapshot)
    initialSnapshot.agents.push({ ...initialSnapshot.agents[0], id: 'agent-2', identity: 'Newton', mentionName: 'newton', runtime: 'pi' })
    const refreshedSnapshot = structuredClone(initialSnapshot)
    refreshedSnapshot.channels.find((channel) => channel.id === 'channel-build')!.memberAgentIds.push('agent-2')
    const addChannelAgent = vi.fn().mockResolvedValue([initialSnapshot.agents[0], initialSnapshot.agents[1]])
    const getBootstrap = vi.fn().mockResolvedValueOnce(initialSnapshot).mockResolvedValueOnce(refreshedSnapshot)
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ addChannelAgent, getBootstrap })} />)

    await user.click(await screen.findByRole('button', { name: '# build' }))
    const context = screen.getByRole('complementary', { name: '任务与上下文' })
    const sections = Array.from(context.querySelectorAll(':scope > section'))
    expect(sections.findIndex((section) => section.classList.contains('channel-agent-members'))).toBeLessThan(
      sections.findIndex((section) => section.textContent?.includes('频道操作')),
    )
    expect(sections.findIndex((section) => section.classList.contains('channel-workspace-bindings'))).toBeLessThan(
      sections.findIndex((section) => section.textContent?.includes('频道操作')),
    )

    await user.click(within(context).getByRole('button', { name: '添加 Agent' }))
    expect(context).not.toHaveAttribute('inert')
    await user.click(screen.getByRole('option', { name: 'Newton' }))

    expect(addChannelAgent).toHaveBeenCalledWith('channel-build', 'agent-2')
    expect(await screen.findByRole('heading', { name: '# build' })).toBeInTheDocument()
    expect(getBootstrap).toHaveBeenCalledTimes(2)
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

    const navigation = await screen.findByRole('navigation', { name: '工作空间' })
    await user.click(within(navigation).getByRole('button', { name: '添加工作空间' }))
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

  it('opens public turn details from timeline activity in the context panel', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [{ turnId: 'turn-1', agentId: 'agent-1', phase: 'preparing', queuePosition: null }],
      'channel-build': [],
    }
    const getConversationTurn = vi.fn().mockResolvedValue(turnDetail)
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(activeSnapshot), getConversationTurn })} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))

    expect(getConversationTurn).toHaveBeenCalledWith('channel-general', 'turn-1')
    expect(await screen.findByRole('heading', { name: 'Turn turn-1' })).toBeInTheDocument()
    const context = screen.getByRole('complementary', { name: '任务与上下文' })
    expect(within(context).getByText('候选 Agent')).toBeInTheDocument()
    expect(within(context).getByText('职责命中 frontend')).toBeInTheDocument()
    expect(within(context).queryByText(/Prompt/)).not.toBeInTheDocument()
    expect(within(context).queryByText(/Runtime raw output/)).not.toBeInTheDocument()
  })

  it('queues a final detail refresh when a terminal event arrives during an in-flight request', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [{ turnId: 'turn-1', agentId: 'agent-1', phase: 'preparing', queuePosition: null }],
      'channel-build': [],
    }
    const refreshedSnapshot = structuredClone(activeSnapshot)
    refreshedSnapshot.activeTurnsByChannel = { 'channel-general': [], 'channel-build': [] }
    const secondRefreshedSnapshot = structuredClone(refreshedSnapshot)
    const completedDetail: ConversationTurnDetailView = {
      ...turnDetail,
      turn: { ...turnDetail.turn, status: 'completed', currentRound: 2, completedAt: '2026-07-31T08:03:00.000Z' },
    }
    let resolveStaleDetail: (detail: ConversationTurnDetailView) => void = () => undefined
    const getConversationTurn = vi.fn()
      .mockResolvedValueOnce(turnDetail)
      .mockImplementationOnce(() => new Promise<ConversationTurnDetailView>((resolve) => { resolveStaleDetail = resolve }))
      .mockResolvedValueOnce(completedDetail)
    const getBootstrap = vi.fn().mockResolvedValueOnce(activeSnapshot).mockResolvedValueOnce(refreshedSnapshot).mockResolvedValue(secondRefreshedSnapshot)
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap, getConversationTurn })} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    expect(await screen.findByRole('heading', { name: 'Turn turn-1' })).toBeInTheDocument()

    vi.useFakeTimers()
    await act(async () => {
      FakeEventSource.instances[0]!.emit('conversation.invocation_updated')
      FakeEventSource.instances[0]!.emit('conversation.turn_completed')
      await vi.advanceTimersByTimeAsync(200)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getConversationTurn).toHaveBeenCalledTimes(2)

    await act(async () => {
      FakeEventSource.instances[0]!.emit('conversation.turn_updated')
      await vi.advanceTimersByTimeAsync(200)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getBootstrap).toHaveBeenCalledTimes(3)
    expect(getConversationTurn).toHaveBeenCalledTimes(2)

    expect(screen.getByRole('heading', { name: 'Turn turn-1' })).toBeInTheDocument()
    expect(screen.queryByText('正在读取 Turn 详情...')).not.toBeInTheDocument()
    await act(async () => {
      resolveStaleDetail(turnDetail)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(getBootstrap).toHaveBeenCalledTimes(3)
    expect(getConversationTurn).toHaveBeenCalledTimes(3)
  })

  it('cancels a non-terminal turn with confirmation and refreshes snapshot plus detail', async () => {
    let resolveCancel: () => void = () => undefined
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [{ turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 }],
      'channel-build': [],
    }
    const cancelledSnapshot = structuredClone(activeSnapshot)
    cancelledSnapshot.activeTurnsByChannel = { 'channel-general': [], 'channel-build': [] }
    const cancelledDetail: ConversationTurnDetailView = {
      ...turnDetail,
      turn: { ...turnDetail.turn, status: 'cancelled', completedAt: '2026-07-31T08:04:00.000Z' },
    }
    const getBootstrap = vi.fn().mockResolvedValueOnce(activeSnapshot).mockResolvedValue(cancelledSnapshot)
    const getConversationTurn = vi.fn().mockResolvedValueOnce(turnDetail).mockResolvedValueOnce(cancelledDetail)
    const cancelConversationTurn = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveCancel = resolve }))
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap, getConversationTurn, cancelConversationTurn })} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(await screen.findByRole('button', { name: '取消 Turn' }))
    const confirm = screen.getByRole('button', { name: '确认取消 Turn turn-1' })
    await user.click(confirm)
    await user.click(confirm)

    expect(cancelConversationTurn).toHaveBeenCalledOnce()
    expect(confirm).toBeDisabled()
    resolveCancel()

    expect(await screen.findByText('已取消')).toBeInTheDocument()
    expect(getBootstrap).toHaveBeenCalledTimes(2)
    expect(getConversationTurn).toHaveBeenCalledTimes(2)
  })

  it('keeps a confirmed cancellation locked when the detail refresh fails and allows retry', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [{ turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 }],
      'channel-build': [],
    }
    const cancelledSnapshot = structuredClone(activeSnapshot)
    cancelledSnapshot.activeTurnsByChannel = { 'channel-general': [], 'channel-build': [] }
    const cancelledDetail: ConversationTurnDetailView = {
      ...turnDetail,
      turn: { ...turnDetail.turn, status: 'cancelled', completedAt: '2026-07-31T08:04:00.000Z' },
    }
    const getConversationTurn = vi.fn()
      .mockResolvedValueOnce(turnDetail)
      .mockRejectedValueOnce(new Error('详情服务暂时不可用'))
      .mockResolvedValueOnce(cancelledDetail)
    const api = makeApi({
      getBootstrap: vi.fn().mockResolvedValueOnce(activeSnapshot).mockResolvedValue(cancelledSnapshot),
      getConversationTurn,
      cancelConversationTurn: vi.fn().mockResolvedValue(undefined),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(await screen.findByRole('button', { name: '取消 Turn' }))
    await user.click(screen.getByRole('button', { name: '确认取消 Turn turn-1' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Turn 已取消，但详情刷新失败')
    expect(getConversationTurn).toHaveBeenCalledTimes(2)
    expect(screen.getByText('已取消')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消 Turn' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认取消 Turn turn-1' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试 Turn 详情' }))

    await waitFor(() => expect(getConversationTurn).toHaveBeenCalledTimes(3))
    expect(screen.getByText('已取消')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps cancellation refresh and errors scoped to the turn selected when they complete', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [
        { turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 },
        { turnId: 'turn-2', agentId: 'agent-1', phase: 'preparing', queuePosition: null },
      ],
      'channel-build': [],
    }
    const terminalSnapshot = structuredClone(activeSnapshot)
    terminalSnapshot.activeTurnsByChannel = { 'channel-general': [], 'channel-build': [] }
    const turnTwo = { ...turnDetail, turn: { ...turnDetail.turn, id: 'turn-2', status: 'responding' as const } }
    const completedTurnTwo = {
      ...turnTwo,
      turn: { ...turnTwo.turn, status: 'completed' as const, completedAt: '2026-07-31T08:05:00.000Z' },
    }
    let resolveCancellationRefresh: (value: WorkspaceSnapshot) => void = () => undefined
    let turnTwoReads = 0
    const getConversationTurn = vi.fn().mockImplementation((_channelId: string, turnId: string) => {
      if (turnId === 'turn-2') return Promise.resolve(turnTwoReads++ === 0 ? turnTwo : completedTurnTwo)
      return Promise.resolve(turnDetail)
    })
    const api = makeApi({
      getBootstrap: vi.fn()
        .mockResolvedValueOnce(activeSnapshot)
        .mockImplementationOnce(() => new Promise<WorkspaceSnapshot>((resolve) => { resolveCancellationRefresh = resolve })),
      getConversationTurn,
      cancelConversationTurn: vi.fn().mockResolvedValue(undefined),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(screen.getByRole('button', { name: '取消 Turn' }))
    await user.click(screen.getByRole('button', { name: '确认取消 Turn turn-1' }))
    await user.click(screen.getByRole('button', { name: '查看 Turn turn-2 活动详情' }))
    expect(await screen.findByRole('heading', { name: 'Turn turn-2' })).toBeInTheDocument()

    await act(async () => {
      resolveCancellationRefresh(terminalSnapshot)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(screen.queryByText(/Turn 已取消，但/)).not.toBeInTheDocument()
  })

  it('retries bootstrap and details after a confirmed cancellation bootstrap failure', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [{ turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 }],
      'channel-build': [],
    }
    const cancelledSnapshot = structuredClone(activeSnapshot)
    cancelledSnapshot.activeTurnsByChannel = { 'channel-general': [], 'channel-build': [] }
    const cancelledDetail = {
      ...turnDetail,
      turn: { ...turnDetail.turn, status: 'cancelled' as const, completedAt: '2026-07-31T08:04:00.000Z' },
    }
    const getBootstrap = vi.fn()
      .mockResolvedValueOnce(activeSnapshot)
      .mockRejectedValueOnce(new Error('Bootstrap 暂时不可用'))
      .mockResolvedValueOnce(cancelledSnapshot)
    const getConversationTurn = vi.fn().mockResolvedValueOnce(turnDetail).mockResolvedValueOnce(cancelledDetail)
    const api = makeApi({ getBootstrap, getConversationTurn, cancelConversationTurn: vi.fn().mockResolvedValue(undefined) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(screen.getByRole('button', { name: '取消 Turn' }))
    await user.click(screen.getByRole('button', { name: '确认取消 Turn turn-1' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Turn 已取消，但工作空间刷新失败')
    expect(screen.getByRole('button', { name: '查看 Turn turn-1 活动详情' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试 Turn 详情' }))

    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('button', { name: '查看 Turn turn-1 活动详情' })).not.toBeInTheDocument()
    expect(screen.getByText('已取消')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('never reuses another turn detail when switching A to B to A with A still loading', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [
        { turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 },
        { turnId: 'turn-2', agentId: 'agent-1', phase: 'preparing', queuePosition: null },
      ],
      'channel-build': [],
    }
    const turnTwo = { ...turnDetail, turn: { ...turnDetail.turn, id: 'turn-2' } }
    let resolveFirstTurnOneRead: (value: ConversationTurnDetailView) => void = () => undefined
    let turnOneReads = 0
    const getConversationTurn = vi.fn().mockImplementation((_channelId: string, turnId: string) => {
      if (turnId === 'turn-2') return Promise.resolve(turnTwo)
      turnOneReads += 1
      return turnOneReads === 1
        ? new Promise<ConversationTurnDetailView>((resolve) => { resolveFirstTurnOneRead = resolve })
        : Promise.resolve(turnDetail)
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(activeSnapshot), getConversationTurn })} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(screen.getByRole('button', { name: '查看 Turn turn-2 活动详情' }))
    expect(await screen.findByRole('heading', { name: 'Turn turn-2' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '查看 Turn turn-1 活动详情' }))

    expect(screen.queryByRole('heading', { name: 'Turn turn-2' })).not.toBeInTheDocument()
    expect(screen.getByText('正在读取 Turn 详情...')).toBeInTheDocument()
    await act(async () => { resolveFirstTurnOneRead(turnDetail) })
    expect(await screen.findByRole('heading', { name: 'Turn turn-1' })).toBeInTheDocument()
    expect(getConversationTurn.mock.calls.filter(([, turnId]) => turnId === 'turn-1')).toHaveLength(2)
  })

  it('preserves bootstrap retry errors per turn while another turn fails to load', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [
        { turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 },
        { turnId: 'turn-2', agentId: 'agent-1', phase: 'queued', queuePosition: 2 },
      ],
      'channel-build': [],
    }
    const getBootstrap = vi.fn()
      .mockResolvedValueOnce(activeSnapshot)
      .mockRejectedValueOnce(new Error('Bootstrap 暂时不可用'))
      .mockResolvedValueOnce({ ...activeSnapshot, activeTurnsByChannel: { 'channel-general': [], 'channel-build': [] } })
    const getConversationTurn = vi.fn().mockImplementation((_channelId: string, turnId: string) => turnId === 'turn-1'
      ? Promise.resolve(turnDetail)
      : Promise.reject(new Error('Turn 2 详情失败')))
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap, getConversationTurn, cancelConversationTurn: vi.fn().mockResolvedValue(undefined) })} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(screen.getByRole('button', { name: '取消 Turn' }))
    await user.click(screen.getByRole('button', { name: '确认取消 Turn turn-1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('工作空间刷新失败')
    await user.click(screen.getByRole('button', { name: '查看 Turn turn-2 活动详情' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn 2 详情失败')
    await user.click(screen.getByRole('button', { name: '查看 Turn turn-1 活动详情' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('工作空间刷新失败')
    await user.click(screen.getByRole('button', { name: '重试 Turn 详情' }))
    await waitFor(() => expect(getBootstrap).toHaveBeenCalledTimes(3))
  })

  it('keeps retry locks scoped to their own turn', async () => {
    const activeSnapshot = structuredClone(snapshot)
    activeSnapshot.activeTurnsByChannel = {
      'channel-general': [
        { turnId: 'turn-1', agentId: 'agent-1', phase: 'queued', queuePosition: 1 },
        { turnId: 'turn-2', agentId: 'agent-1', phase: 'queued', queuePosition: 2 },
      ],
      'channel-build': [],
    }
    const never = new Promise<ConversationTurnDetailView>(() => undefined)
    let turnOneReads = 0
    const getConversationTurn = vi.fn().mockImplementation((_channelId: string, turnId: string) => {
      if (turnId === 'turn-1') return ++turnOneReads === 1 ? Promise.reject(new Error('Turn 1 详情失败')) : never
      return Promise.reject(new Error('Turn 2 详情失败'))
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(activeSnapshot), getConversationTurn })} />)

    await user.click(await screen.findByRole('button', { name: '查看 Turn turn-1 活动详情' }))
    await user.click(await screen.findByRole('button', { name: '重试 Turn 详情' }))
    await user.click(screen.getByRole('button', { name: '查看 Turn turn-2 活动详情' }))

    const retryTurnTwo = await screen.findByRole('button', { name: '重试 Turn 详情' })
    expect(retryTurnTwo).toBeEnabled()
  })

  it('opens a Thread and sends replies under its root message', async () => {
    const threadedSnapshot = structuredClone(snapshot)
    threadedSnapshot.recentMessages.push({
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
    const createdChannel = { id: 'channel-release', name: 'release', systemKey: null, memberAgentIds: [], boundWorkspaceIds: [], createdAt: '2026-07-25T10:00:00.000Z' }
    const updated = structuredClone(snapshot)
    updated.channels.push(createdChannel)
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

    expect(api.createChannel).toHaveBeenCalledWith({ name: 'release' })
    expect(await screen.findByRole('heading', { name: '# release' })).toBeInTheDocument()
  })

  it('keeps the channel dialog open when its post-create refresh fails', async () => {
    const createdChannel = { id: 'channel-release', name: 'release', systemKey: null, memberAgentIds: [], boundWorkspaceIds: [], createdAt: '2026-07-25T10:00:00.000Z' }
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

    expect(api.createTask).toHaveBeenCalledWith('channel-build', {
      workspaceId: 'workspace-1',
      title: '修复导航',
      description: '修复导航',
      acceptanceCriteria: '任务完成后在当前频道说明结果。',
      labels: [],
      directAgentId: 'agent-1',
    })
    expect(api.postMessage).not.toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent('任务已派发。')
  })

  it('opens the task composer for /task when workspace selection is ambiguous', async () => {
    const multiWorkspaceSnapshot = structuredClone(snapshot)
    const releaseWorkspace = structuredClone(snapshot.workspaces[0])
    releaseWorkspace.id = 'workspace-2'
    releaseWorkspace.name = 'Release'
    releaseWorkspace.repositories[0] = { ...releaseWorkspace.repositories[0], id: 'repository-2', workspaceId: 'workspace-2', path: '/code/release' }
    multiWorkspaceSnapshot.workspaces.push(releaseWorkspace)
    multiWorkspaceSnapshot.agents.push({ ...multiWorkspaceSnapshot.agents[0], id: 'agent-2', identity: '外部 Agent', mentionName: 'outsider' })
    multiWorkspaceSnapshot.channels[1].boundWorkspaceIds = ['workspace-1', 'workspace-2']
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue(multiWorkspaceSnapshot), createTask: vi.fn() })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '# build' }))
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '/task @builder 修复导航')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    expect(screen.getByRole('dialog', { name: '把工作交给队列' })).toBeInTheDocument()
    expect(screen.getByLabelText('任务标题')).toHaveValue('修复导航')
    expect(screen.getByLabelText('指定 Agent')).toHaveValue('agent-1')
    expect(screen.getByRole('combobox', { name: '工作空间' })).toHaveValue('')
    expect(within(screen.getByLabelText('指定 Agent')).queryByRole('option', { name: /外部 Agent/ })).not.toBeInTheDocument()
    expect(api.createTask).not.toHaveBeenCalled()
  })

  it('opens a blocked composer for /task when the channel has no workspace binding', async () => {
    const unboundSnapshot = structuredClone(snapshot)
    unboundSnapshot.channels[1].boundWorkspaceIds = []
    const api = makeApi({ getBootstrap: vi.fn().mockResolvedValue(unboundSnapshot), createTask: vi.fn() })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '# build' }))
    await user.type(screen.getByRole('textbox', { name: '发送消息' }), '/task 修复导航')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    const dialog = screen.getByRole('dialog', { name: '把工作交给队列' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('请先为频道绑定工作空间')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建任务' })).toBeDisabled()
    expect(api.createTask).not.toHaveBeenCalled()
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

  it('loads details after selecting a task in the current channel', async () => {
    const initialTask = { ...createdTask, channelId: 'channel-general', status: 'queued' as const }
    const initialDetails = { ...createdTaskDetails, task: initialTask }
    const initialSnapshot = structuredClone(snapshot)
    initialSnapshot.tasks = [initialTask]
    const refreshedSnapshot = structuredClone(initialSnapshot)
    const api = makeApi({
      getBootstrap: vi.fn().mockResolvedValueOnce(initialSnapshot).mockResolvedValueOnce(refreshedSnapshot),
      getTaskDetails: vi.fn().mockResolvedValue(initialDetails),
    })

    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '补齐任务详情' }))
    expect(await screen.findByRole('heading', { name: '概览' })).toBeInTheDocument()
    expect(api.getTaskDetails).toHaveBeenCalledWith('task-new')
  })

  it('creates an Agent from the workspace sidebar', async () => {
    const api = makeApi({ createAgent: vi.fn().mockResolvedValue(snapshot.agents[0]) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    const navigation = await screen.findByRole('navigation', { name: '工作空间' })
    await user.click(within(navigation).getByRole('button', { name: '添加 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '添加 Agent' })
    await user.type(within(dialog).getByLabelText('Agent 名称'), '验证 Agent')
    await user.type(within(dialog).getByLabelText('能力标签'), 'typescript, test')
    await user.click(within(dialog).getByRole('button', { name: '添加 Agent' }))

    expect(api.createAgent).toHaveBeenCalledWith({
      identity: '验证 Agent', mention: '验证-agent', runtime: 'opencode', capabilityTags: ['typescript', 'test'], responsibilities: [],
    })
  })

  it('allows selecting Claude Code when creating an Agent', async () => {
    const api = makeApi({ createAgent: vi.fn().mockResolvedValue(snapshot.agents[0]) })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    const navigation = await screen.findByRole('navigation', { name: '工作空间' })
    await user.click(within(navigation).getByRole('button', { name: '添加 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '添加 Agent' })

    await user.type(within(dialog).getByLabelText('Agent 名称'), 'Claude Agent')
    await user.selectOptions(within(dialog).getByLabelText('Runtime'), 'claude-code')
    await user.type(within(dialog).getByLabelText('能力标签'), 'review')
    await user.click(within(dialog).getByRole('button', { name: '添加 Agent' }))

    expect(api.createAgent).toHaveBeenCalledWith({
      identity: 'Claude Agent', mention: 'claude-agent', runtime: 'claude-code', capabilityTags: ['review'], responsibilities: [],
    })
  })

  it('shows Claude Code runtime copy in the agent config dialog', async () => {
    const claudeSnapshot = structuredClone(snapshot)
    claudeSnapshot.agents[0].runtime = 'claude-code'
    claudeSnapshot.agents[0].model = ''

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
    updated.agents[0].status = 'busy'
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
    initialSnapshot.tasks = [initialTask]
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
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '补齐任务详情' }))
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

  it('keeps the context task list scoped to the selected channel after opening a task', async () => {
    const scopedSnapshot = structuredClone(snapshot)
    scopedSnapshot.tasks.push({
      ...scopedSnapshot.tasks[0],
      id: 'task-general',
      channelId: 'channel-general',
      title: '仅属于 general 的任务',
      status: 'queued',
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(scopedSnapshot) })} />)

    await user.click(await screen.findByRole('button', { name: '# build' }))
    await user.click(screen.getByRole('button', { name: '修复频道界面' }))

    const context = screen.getByRole('complementary', { name: '任务与上下文' })
    expect(within(context).queryByRole('button', { name: /仅属于 general 的任务/ })).not.toBeInTheDocument()
  })

  it('clears selected task details when its workspace is unbound and later rebound', async () => {
    const initialSnapshot = structuredClone(snapshot)
    const releaseWorkspace = structuredClone(initialSnapshot.workspaces[0])
    releaseWorkspace.id = 'workspace-2'
    releaseWorkspace.name = 'Release'
    releaseWorkspace.repositories[0] = {
      ...releaseWorkspace.repositories[0],
      id: 'repository-2',
      workspaceId: 'workspace-2',
      path: '/code/release',
    }
    initialSnapshot.workspaces.push(releaseWorkspace)
    initialSnapshot.channels[1].boundWorkspaceIds = ['workspace-1', 'workspace-2']
    const updatedSnapshot = structuredClone(initialSnapshot)
    updatedSnapshot.channels[1].boundWorkspaceIds = ['workspace-2']
    const reboundSnapshot = structuredClone(initialSnapshot)
    const api = makeApi({
      bindChannelWorkspace: vi.fn().mockResolvedValue([releaseWorkspace, initialSnapshot.workspaces[0]]),
      unbindChannelWorkspace: vi.fn().mockResolvedValue([releaseWorkspace]),
      getBootstrap: vi.fn()
        .mockResolvedValueOnce(initialSnapshot)
        .mockResolvedValueOnce(updatedSnapshot)
        .mockResolvedValueOnce(reboundSnapshot),
    })
    const user = userEvent.setup()
    render(<WorkspaceShell api={api} />)

    await user.click(await screen.findByRole('button', { name: '# build' }))
    await user.click(screen.getByRole('button', { name: '修复频道界面' }))
    expect(await screen.findByRole('heading', { name: '概览' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '解绑 Sinapsis' }))
    await user.click(within(screen.getByRole('dialog', { name: '解绑 Sinapsis' })).getByRole('button', { name: '解绑工作空间' }))

    expect(api.unbindChannelWorkspace).toHaveBeenCalledWith('channel-build', 'workspace-1')
    await waitFor(() => expect(screen.queryByRole('heading', { name: '概览' })).not.toBeInTheDocument())
    const workspaceGroup = screen.getByRole('group', { name: 'build 的工作空间' })
    expect(within(workspaceGroup).getByRole('button', { name: /Release/ })).toHaveAttribute('aria-pressed', 'true')
    const context = screen.getByRole('complementary', { name: '任务与上下文' })
    await user.click(within(context).getByRole('button', { name: '添加工作空间' }))
    await user.click(screen.getByRole('option', { name: 'Sinapsis' }))

    expect(api.bindChannelWorkspace).toHaveBeenCalledWith('channel-build', 'workspace-1')
    await waitFor(() => expect(api.getBootstrap).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('heading', { name: '概览' })).not.toBeInTheDocument()
  })

  it('resets a still-valid workspace selection when changing channels', async () => {
    const multiWorkspaceSnapshot = structuredClone(snapshot)
    const releaseWorkspace = structuredClone(multiWorkspaceSnapshot.workspaces[0])
    releaseWorkspace.id = 'workspace-2'
    releaseWorkspace.name = 'Release'
    releaseWorkspace.repositories[0] = {
      ...releaseWorkspace.repositories[0],
      id: 'repository-2',
      workspaceId: 'workspace-2',
      path: '/code/release',
    }
    multiWorkspaceSnapshot.workspaces.push(releaseWorkspace)
    multiWorkspaceSnapshot.channels[0].boundWorkspaceIds = ['workspace-1', 'workspace-2']
    multiWorkspaceSnapshot.channels[1].boundWorkspaceIds = ['workspace-1', 'workspace-2']
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi({ getBootstrap: vi.fn().mockResolvedValue(multiWorkspaceSnapshot) })} />)

    const generalWorkspaces = await screen.findByRole('group', { name: 'general 的工作空间' })
    await user.click(within(generalWorkspaces).getByRole('button', { name: /Release/ }))
    expect(within(generalWorkspaces).getByRole('button', { name: /Release/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '# build' }))

    const buildWorkspaces = screen.getByRole('group', { name: 'build 的工作空间' })
    expect(within(buildWorkspaces).getByRole('button', { name: /Sinapsis/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(buildWorkspaces).getByRole('button', { name: /Release/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('resets the selected task when changing channels', async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell api={makeApi()} />)

    await user.click(await screen.findByRole('button', { name: '# build' }))
    await user.click(screen.getByRole('button', { name: '修复频道界面' }))
    expect(screen.getByRole('button', { name: '修复频道界面' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: '# general' }))
    await user.click(screen.getByRole('button', { name: '# build' }))
    expect(screen.getByRole('button', { name: '修复频道界面' })).toHaveAttribute('aria-pressed', 'false')
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
    updated.tasks.push(createdTask)
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

    expect(api.createTask).toHaveBeenCalledWith('channel-general', {
      workspaceId: 'workspace-1',
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

describe('ApiClient', () => {
  it('uses channel-scoped membership and workspace binding routes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const api = new ApiClient()

    try {
      await api.addChannelAgent('channel-build', 'agent-2')
      await api.removeChannelAgent('channel-build', 'agent-2')
      await api.bindChannelWorkspace('channel-build', 'workspace-2')
      await api.unbindChannelWorkspace('channel-build', 'workspace-2')

      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/channels/channel-build/agents', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-2' }),
      }))
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/channels/channel-build/agents/agent-2', expect.objectContaining({
        method: 'DELETE',
      }))
      expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/channels/channel-build/workspaces', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'workspace-2' }),
      }))
      expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/channels/channel-build/workspaces/workspace-2', expect.objectContaining({
        method: 'DELETE',
      }))
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('uses the global agent and channel routes and channel-scoped task route', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const api = new ApiClient()

    try {
      await api.createAgent({
        identity: '实现 Agent',
        mention: 'builder',
        runtime: 'opencode',
        capabilityTags: ['frontend'],
      })
      await api.createChannel({ name: 'build' })
      await api.createTask('channel-build', {
        workspaceId: 'workspace-1',
        title: '修复导航',
        description: '修复导航',
        acceptanceCriteria: '通过测试',
        labels: ['frontend'],
        directAgentId: 'agent-1',
      })
      await api.refreshAgentRuntime('agent-1')

      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/agents', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          identity: '实现 Agent',
          mention: 'builder',
          runtime: 'opencode',
          capabilityTags: ['frontend'],
        }),
      }))
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/channels', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'build' }),
      }))
      expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/channels/channel-build/tasks', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          title: '修复导航',
          description: '修复导航',
          acceptanceCriteria: '通过测试',
          labels: ['frontend'],
          directAgentId: 'agent-1',
        }),
      }))
      expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/agents/agent-1/refresh-runtime', expect.objectContaining({
        method: 'POST',
      }))
    } finally {
      fetchMock.mockRestore()
    }
  })
})
