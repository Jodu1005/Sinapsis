import { PanelRightClose, PanelRightOpen, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CreateAgentRequest, CreateTaskRequest, WorkspaceApi } from '../api/client'
import { ApiClient } from '../api/client'
import { useWorkspaceEvents } from '../api/use-workspace-events'
import { snapshotAgents, snapshotChannelMessages, type AgentView, type ChannelMessage, type RepositoryView, type TaskDetailView, type TaskView, type WorkspaceSnapshot, type WorkspaceView } from '../domain/workspace-view'
import { parseMessageIntent } from '../domain/message-intent'
import { AgentConfigDialog } from './AgentConfigDialog'
import { AgentCreateDialog } from './AgentCreateDialog'
import { ChannelTimeline } from './ChannelTimeline'
import { MessageComposer } from './MessageComposer'
import { NavigationToggle, RepositorySidebar } from './RepositorySidebar'
import { TaskComposerPanel } from './TaskComposerPanel'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TaskList } from './TaskList'
import { WorkspaceSetup } from './WorkspaceSetup'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'
import { ChannelCreateDialog } from './ChannelCreateDialog'
import { ThreadPanel } from './ThreadPanel'
import { ChannelContextResetDialog } from './ChannelContextResetDialog'
import { ChannelAgentMembers } from './ChannelAgentMembers'
import { ChannelWorkspaceBindings } from './ChannelWorkspaceBindings'
import { canResetChannelContext } from '../../shared/channel-policy'

export function WorkspaceShell({ api: providedApi }: { api?: WorkspaceApi }) {
  const [defaultApi] = useState(() => new ApiClient())
  const api = providedApi ?? defaultApi
  const [storedSelection] = useState(readStoredSelection)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(storedSelection?.channelId ?? null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskRepositoryId, setSelectedTaskRepositoryId] = useState<string | null>(null)
  const [taskDetails, setTaskDetails] = useState<TaskDetailView | null>(null)
  const [taskDetailsError, setTaskDetailsError] = useState<string | null>(null)
  const [taskComposerDraft, setTaskComposerDraft] = useState<TaskComposerDraft | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<AgentView | null>(null)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [channelActionError, setChannelActionError] = useState<string | null>(null)
  const [refreshingAgentId, setRefreshingAgentId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<string | null>(null)
  const [contextResetDialogOpen, setContextResetDialogOpen] = useState(false)
  const [resettingChannelContext, setResettingChannelContext] = useState(false)
  const narrowNavigation = useMediaQuery('(max-width: 700px)')
  const narrowContext = useMediaQuery('(max-width: 980px)')
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.getBootstrap())
      setError(null)
    } catch (cause) {
      const refreshError = cause instanceof Error ? cause : new Error('无法读取工作空间。')
      setError(refreshError.message)
      throw refreshError
    }
  }, [api])
  const refreshInBackground = useCallback(() => { void refresh().catch(() => undefined) }, [refresh])
  const reconnecting = useWorkspaceEvents(refreshInBackground)
  useEffect(() => { refreshInBackground() }, [refreshInBackground])

  const selection = useMemo(() => findSelection(snapshot, selectedChannelId, selectedWorkspaceId), [snapshot, selectedChannelId, selectedWorkspaceId])
  const workspace = selection.workspace
  useEffect(() => { if (selection.workspace && selectedWorkspaceId !== selection.workspace.id) setSelectedWorkspaceId(selection.workspace.id) }, [selection.workspace, selectedWorkspaceId])
  useEffect(() => { if (!selection.workspace && selectedWorkspaceId) setSelectedWorkspaceId(null) }, [selection.workspace, selectedWorkspaceId])
  useEffect(() => { if (selection.channel && selectedChannelId !== selection.channel.id) setSelectedChannelId(selection.channel.id) }, [selection.channel, selectedChannelId])
  useEffect(() => {
    if (!selection.channel) return
    storeSelection({ channelId: selection.channel.id })
  }, [selection.channel])
  useEffect(() => {
    if (!selectedAgent) return
    const nextSelectedAgent = snapshot ? snapshotAgents(snapshot).find((agent) => agent.id === selectedAgent.id) ?? null : null
    setSelectedAgent(nextSelectedAgent)
  }, [snapshot, selectedAgent])
  const taskRepository = useMemo(() => findRepository(workspace, selectedTaskRepositoryId), [workspace, selectedTaskRepositoryId])
  const taskScope = taskRepository ?? workspace?.repositories[0]
  const taskScopeTasks = useMemo(() => snapshot?.tasks.filter((task) =>
    task.workspaceId === workspace?.id
    && task.repositoryId === taskScope?.id
    && task.channelId === selection.channel?.id) ?? [], [snapshot, workspace, taskScope, selection.channel])
  const selectedTask = useMemo(
    () => findTask(snapshot, selectedTaskId, selection.channel?.id, selection.channel?.boundWorkspaceIds ?? []),
    [snapshot, selectedTaskId, selection.channel],
  )
  const messages = useMemo(() => snapshot && selection.channel ? snapshotChannelMessages(snapshot, selection.channel.id) : [], [snapshot, selection.channel])
  const agents = useMemo(() => {
    const allAgents = snapshot ? snapshotAgents(snapshot) : []
    return selection.channel ? allAgents.filter((agent) => selection.channel!.memberAgentIds.includes(agent.id)) : allAgents
  }, [snapshot, selection.channel])
  const typingAgents = useMemo(() => {
    const typingIds = selection.channel ? snapshot?.typingAgentIdsByChannel?.[selection.channel.id] ?? [] : []
    return agents.filter((agent) => typingIds.includes(agent.id))
  }, [agents, selection.channel, snapshot])
  const threadRoot = useMemo(() => selectedThreadRootId ? messages.find((message) => message.id === selectedThreadRootId && !message.threadRootMessageId) : undefined, [messages, selectedThreadRootId])
  const threadReplies = useMemo(() => threadRoot ? messages.filter((message) => message.threadRootMessageId === threadRoot.id) : [], [messages, threadRoot])

  useEffect(() => {
    if (!selectedTask) { setTaskDetails(null); setTaskDetailsError(null); return undefined }
    let active = true
    setTaskDetails(null)
    setTaskDetailsError(null)
    void api.getTaskDetails(selectedTask.id).then(
      (details) => { if (active) setTaskDetails(details) },
      (cause: unknown) => { if (active) setTaskDetailsError(cause instanceof Error ? cause.message : '无法读取任务详情。') },
    )
    return () => { active = false }
  }, [api, selectedTask?.id, snapshot])

  if (!snapshot) return <main className="workspace-loading"><p>{error ?? '正在连接本机工作空间...'}</p>{error && <button type="button" onClick={refreshInBackground}>重试</button>}</main>
  if (snapshot.workspaces.length === 0) return <WorkspaceSetup api={api} onComplete={refresh} />
  if (!selection.channel) return <main className="workspace-loading"><p>还没有频道。</p></main>

  const sendMessage = async (body: string) => {
    if (selection.channel?.archivedAt) throw new Error('此频道已归档，只能查看历史记录。')
    const intent = parseMessageIntent(body, agents)
    if (intent.kind === 'error') throw new Error(intent.message)
    if (intent.kind === 'message') {
      await api.postMessage(selection.channel!.id, { body: intent.body })
      await refresh()
      return undefined
    }

    if (selection.boundWorkspaces.length !== 1) {
      setTaskComposerDraft({
        initialTitle: intent.title,
        initialDirectAgentId: intent.directAgentId,
      })
      return undefined
    }

    const taskWorkspace = selection.boundWorkspaces[0]
    const repository = taskWorkspace.repositories[0]
    if (!repository) throw new Error('当前工作空间没有可用的代码仓。')
    const task = await api.createTask(selection.channel.id, {
      workspaceId: taskWorkspace.id,
      title: intent.title,
      description: intent.title,
      acceptanceCriteria: '任务完成后在当前频道说明结果。',
      labels: [],
      directAgentId: intent.directAgentId,
    })
    await refresh()
    setSelectedWorkspaceId(taskWorkspace.id)
    setSelectedTaskRepositoryId(repository.id)
    setSelectedTaskId(task.id)
    setSelectedThreadRootId(task.threadRootMessageId ?? null)
    setContextOpen(true)
    return { notice: '任务已派发。' }
  }
  const sendThreadMessage = async (body: string) => {
    if (!threadRoot) return undefined
    if (selection.channel?.archivedAt) throw new Error('此频道已归档，只能查看历史记录。')
    await api.postMessage(selection.channel!.id, { body, threadRootMessageId: threadRoot.id })
    await refresh()
    return undefined
  }
  const selectChannel = (channelId: string) => {
    setSelectedChannelId(channelId)
    setSelectedWorkspaceId(null)
    setSelectedThreadRootId(null)
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
    setTaskComposerDraft(null)
    setChannelActionError(null)
    setNavOpen(false)
  }
  const selectWorkspace = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
  }
  const selectTask = (repositoryId: string, taskId: string) => { setSelectedTaskRepositoryId(repositoryId); setSelectedTaskId(taskId); setContextOpen(true); setNavOpen(false) }
  const createTask = async (input: CreateTaskRequest) => {
    if (selection.channel?.archivedAt) throw new Error('此频道已归档，不能创建任务。')
    const taskWorkspace = selection.boundWorkspaces.find((candidate) => candidate.id === input.workspaceId)
    const repository = taskWorkspace?.repositories[0]
    if (!taskWorkspace || !repository) throw new Error('没有可用的工作目录。')
    const task = await api.createTask(selection.channel!.id, input)
    await refresh()
    setTaskComposerDraft(null)
    setSelectedWorkspaceId(taskWorkspace.id)
    setSelectedTaskRepositoryId(repository.id)
    setSelectedTaskId(task.id)
    setSelectedThreadRootId(task.threadRootMessageId ?? null)
    setContextOpen(true)
    return task
  }
  const queueTaskInput = async (taskId: string, body: string) => {
    const queued = await api.queueTaskInput(taskId, body)
    setTaskDetails((details) => details?.task.id === taskId ? { ...details, inputs: [...details.inputs, queued] } : details)
  }
  const reviewTask = async (taskId: string, action: 'accept' | 'return') => {
    const task = await api.reviewTask(taskId, action, action === 'accept' ? '验收已通过。' : '请根据任务证据继续修改。')
    setTaskDetails((details) => details?.task.id === taskId ? { ...details, task } : details)
    await refresh()
  }
  const requeueTask = async (taskId: string) => {
    const task = await api.requeueTask(taskId)
    setTaskDetails((details) => details?.task.id === taskId ? { ...details, task } : details)
    await refresh()
  }
  const createAgent = async (input: CreateAgentRequest) => {
    await api.createAgent(input)
    await refresh()
    setCreatingAgent(false)
  }
  const createWorkspace = async (input: { name: string; directory: string }) => {
    const nextWorkspace = await api.createWorkspace({ name: input.name })
    await api.addRepository(nextWorkspace.id, { directory: input.directory })
    await refresh()
    setCreatingWorkspace(false)
  }
  const createChannel = async (input: { name: string }) => {
    const channel = await api.createChannel(input)
    await refresh()
    setSelectedChannelId(channel.id)
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
    setCreatingChannel(false)
  }
  const archiveChannel = async (channelId: string) => {
    setChannelActionError(null)
    try {
      await api.archiveChannel(channelId)
      await refresh()
    } catch (cause) {
      setChannelActionError(cause instanceof Error ? cause.message : '无法归档频道。')
    }
  }
  const restoreChannel = async (channelId: string) => {
    setChannelActionError(null)
    try {
      await api.restoreChannel(channelId)
      await refresh()
    } catch (cause) {
      setChannelActionError(cause instanceof Error ? cause.message : '无法恢复频道。')
    }
  }
  const resetChannelContext = async () => {
    if (!selection.channel || resettingChannelContext) return
    setResettingChannelContext(true)
    setChannelActionError(null)
    try {
      await api.resetChannelContext(selection.channel.id)
      setSelectedTaskId(null)
      setSelectedTaskRepositoryId(null)
      setTaskDetails(null)
      setSelectedThreadRootId(null)
      await refresh()
      setContextResetDialogOpen(false)
      setResettingChannelContext(false)
    } catch (cause) {
      setResettingChannelContext(false)
      const resetError = cause instanceof Error ? cause : new Error('无法清空频道上下文。')
      setChannelActionError(resetError.message)
      throw resetError
    }
  }
  const refreshAgentRuntime = async () => {
    if (!selectedAgent || refreshingAgentId) return
    setRefreshingAgentId(selectedAgent.id)
    try {
      await api.refreshAgentRuntime(selectedAgent.id)
      await refresh()
    } finally {
      setRefreshingAgentId(null)
    }
  }
  const updateAgentResponsibilities = async (responsibilities: string[]) => {
    if (!selectedAgent) return
    const updated = await api.updateAgentResponsibilities(selectedAgent.id, responsibilities)
    setSelectedAgent(updated)
    await refresh()
  }
  return <div className="workspace-shell">
    <RepositorySidebar workspaces={snapshot.workspaces} agents={agents} channels={snapshot.channels} tasks={snapshot.tasks} selectedChannelId={selection.channel.id} selectedWorkspaceId={workspace?.id ?? null} selectedTaskId={selectedTask?.id ?? null} onSelectChannel={selectChannel} onSelectWorkspace={selectWorkspace} onSelectTask={selectTask} onCreateTask={(workspaceId) => setTaskComposerDraft({ initialWorkspaceId: workspaceId })} onCreateChannel={() => setCreatingChannel(true)} onArchiveChannel={archiveChannel} onRestoreChannel={restoreChannel} channelReadOnly={Boolean(selection.channel.archivedAt)} onCreateWorkspace={() => setCreatingWorkspace(true)} onSelectAgent={setSelectedAgent} onCreateAgent={() => setCreatingAgent(true)} mobileOpen={navOpen} mobileHidden={narrowNavigation && !navOpen} onClose={() => setNavOpen(false)} />
    <main className="conversation-panel">
      <header className="channel-header"><NavigationToggle onClick={() => setNavOpen(true)} /><div className="channel-heading"><h1># {selection.channel.name}</h1><p>{selection.channel.archivedAt ? '已归档频道 · 只读' : '全局频道'}</p></div><div className="header-actions"><span className="connection-state" data-reconnecting={reconnecting}>{reconnecting ? '正在重新连接' : '已连接'}</span><button type="button" className="icon-button" aria-label="打开上下文" data-tooltip="打开上下文" onClick={() => setContextOpen(true)}><PanelRightOpen size={18} /></button></div></header>
      {channelActionError && <p className="channel-action-error" role="alert">{channelActionError}</p>}
      <ChannelTimeline messages={messages} typingAgents={typingAgents} onOpenThread={(message) => { setSelectedThreadRootId(message.id); setContextOpen(true) }} />
      {selection.channel.archivedAt ? <div className="archived-channel-notice" role="status">此频道已归档，只能查看历史记录。</div> : <MessageComposer channelName={selection.channel.name} agents={agents} onSend={sendMessage} />}
    </main>
    <aside className="context-panel" aria-label="任务与上下文" aria-hidden={narrowContext && !contextOpen || undefined} inert={narrowContext && !contextOpen} data-mobile-open={contextOpen}>
      <header className="context-header"><strong>上下文</strong><button type="button" className="icon-button context-close" aria-label="关闭上下文" data-tooltip="关闭上下文" onClick={() => setContextOpen(false)}><X size={17} /></button></header>
      {threadRoot && <ThreadPanel root={threadRoot} replies={threadReplies} agents={agents} readOnly={Boolean(selection.channel.archivedAt)} onSend={sendThreadMessage} onClose={() => setSelectedThreadRootId(null)} />}
      {taskScope && workspace && <section className="context-section"><div className="context-section-heading"><h2>{taskRepository ? `${taskRepository.name} 任务` : `${workspace.name} 任务`}</h2>{!selection.channel.archivedAt && <button type="button" className="icon-button" aria-label="新建当前上下文任务" data-tooltip="新建任务" onClick={() => setTaskComposerDraft({ initialWorkspaceId: workspace.id })}>+</button>}</div><TaskList tasks={taskScopeTasks} selectedTaskId={selectedTask?.id ?? null} onSelect={setSelectedTaskId} /></section>}
      {selectedTask && <section className="context-section task-details-context">{taskDetails ? <TaskDetailPanel details={taskDetails} onQueueInput={(body) => queueTaskInput(taskDetails.task.id, body)} onReview={(action) => reviewTask(taskDetails.task.id, action)} onRequeue={() => requeueTask(taskDetails.task.id)} onReadArtifact={(artifactId) => api.readArtifact(taskDetails.task.id, artifactId)} /> : <p className="context-empty">{taskDetailsError ?? '正在读取任务详情...'}</p>}</section>}
      <ChannelAgentMembers channel={selection.channel} agents={snapshotAgents(snapshot)} api={api} onChanged={refresh} />
      <ChannelWorkspaceBindings channel={selection.channel} workspaces={snapshot.workspaces} limit={snapshot.maxWorkspaceBindingsPerChannel} api={api} onChanged={refresh} />
      <section className="context-section"><h2>频道操作</h2>{!selection.channel.archivedAt && canResetChannelContext(selection.channel.name) && <button type="button" className="context-action context-danger" onClick={() => setContextResetDialogOpen(true)}><Trash2 size={16} /> 清空频道上下文</button>}<button type="button" className="context-action" onClick={() => setContextOpen(false)}><PanelRightClose size={16} /> 收起上下文</button></section>
    </aside>
    {taskComposerDraft && <TaskComposerPanel workspaces={selection.boundWorkspaces} agents={agents} initialWorkspaceId={taskComposerDraft.initialWorkspaceId} initialTitle={taskComposerDraft.initialTitle} initialDirectAgentId={taskComposerDraft.initialDirectAgentId} onCreate={createTask} onClose={() => setTaskComposerDraft(null)} />}
    {creatingWorkspace && <WorkspaceCreateDialog onCreate={createWorkspace} onClose={() => setCreatingWorkspace(false)} />}
    {creatingChannel && <ChannelCreateDialog onCreate={createChannel} onClose={() => setCreatingChannel(false)} />}
    {creatingAgent && <AgentCreateDialog onCreate={createAgent} onClose={() => setCreatingAgent(false)} />}
    {selectedAgent && <AgentConfigDialog agent={selectedAgent} refreshingRuntime={refreshingAgentId === selectedAgent.id} onRefreshRuntime={refreshAgentRuntime} onUpdateResponsibilities={updateAgentResponsibilities} onClose={() => setSelectedAgent(null)} />}
    {contextResetDialogOpen && <ChannelContextResetDialog channelName={selection.channel.name} onConfirm={resetChannelContext} onClose={() => setContextResetDialogOpen(false)} />}
  </div>
}

function findSelection(snapshot: WorkspaceSnapshot | null, selectedChannelId: string | null, selectedWorkspaceId: string | null) {
  const channel = snapshot?.channels.find((candidate) => candidate.id === selectedChannelId) ?? snapshot?.channels[0]
  if (!snapshot || !channel) return { boundWorkspaces: [], workspace: undefined, repository: undefined, channel: undefined }
  const boundWorkspaces = snapshot.workspaces.filter((workspace) => channel.boundWorkspaceIds.includes(workspace.id))
  const workspace = boundWorkspaces.find((candidate) => candidate.id === selectedWorkspaceId) ?? boundWorkspaces[0]
  return { boundWorkspaces, workspace, repository: workspace?.repositories[0], channel }
}

function findTask(snapshot: WorkspaceSnapshot | null, taskId: string | null, channelId: string | undefined, boundWorkspaceIds: string[]): TaskView | undefined {
  if (!taskId || !channelId) return undefined
  return snapshot?.tasks.find((task) =>
    task.id === taskId
    && task.channelId === channelId
    && boundWorkspaceIds.includes(task.workspaceId),
  )
}

function findRepository(workspace: WorkspaceView | undefined, repositoryId: string | null): RepositoryView | undefined {
  if (!repositoryId) return undefined
  return workspace?.repositories.find((repository) => repository.id === repositoryId)
}

function useMediaQuery(query: string): boolean {
  const getMatches = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [matches, setMatches] = useState(getMatches)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

const selectionStorageKey = 'sinapsis:workspace-selection'

interface TaskComposerDraft {
  initialWorkspaceId?: string
  initialTitle?: string
  initialDirectAgentId?: string
}

function readStoredSelection(): { channelId: string } | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(selectionStorageKey) ?? 'null')
    if (!value || typeof value !== 'object' || !('channelId' in value)) return undefined
    const { channelId } = value as { channelId?: unknown }
    return typeof channelId === 'string' ? { channelId } : undefined
  } catch {
    return undefined
  }
}

function storeSelection(selection: { channelId: string }): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(selectionStorageKey, JSON.stringify(selection))
}
