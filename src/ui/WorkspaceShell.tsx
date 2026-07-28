import { PanelRightClose, PanelRightOpen, X } from 'lucide-react'
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

export function WorkspaceShell({ api: providedApi }: { api?: WorkspaceApi }) {
  const [defaultApi] = useState(() => new ApiClient())
  const api = providedApi ?? defaultApi
  const [storedSelection] = useState(readStoredSelection)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(storedSelection?.workspaceId ?? null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(storedSelection?.channelId ?? null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskRepositoryId, setSelectedTaskRepositoryId] = useState<string | null>(null)
  const [taskDetails, setTaskDetails] = useState<TaskDetailView | null>(null)
  const [taskDetailsError, setTaskDetailsError] = useState<string | null>(null)
  const [composerRepositoryId, setComposerRepositoryId] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<AgentView | null>(null)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [creatingChannelRepositoryId, setCreatingChannelRepositoryId] = useState<string | null>(null)
  const [channelActionError, setChannelActionError] = useState<string | null>(null)
  const [refreshingAgentId, setRefreshingAgentId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<string | null>(null)
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

  const selection = useMemo(() => findSelection(snapshot, selectedChannelId), [snapshot, selectedChannelId])
  const workspace = selection.workspace ?? snapshot?.workspaces.find((candidate) => candidate.id === selectedWorkspaceId) ?? snapshot?.workspaces[0]
  useEffect(() => { if (selection.workspace && selectedWorkspaceId !== selection.workspace.id) setSelectedWorkspaceId(selection.workspace.id) }, [selection.workspace, selectedWorkspaceId])
  useEffect(() => { if (workspace && selectedWorkspaceId !== workspace.id) setSelectedWorkspaceId(workspace.id) }, [workspace, selectedWorkspaceId])
  useEffect(() => { if (selection.channel && selectedChannelId !== selection.channel.id) setSelectedChannelId(selection.channel.id) }, [selection.channel, selectedChannelId])
  useEffect(() => {
    if (!workspace || !selection.channel) return
    storeSelection({ workspaceId: workspace.id, channelId: selection.channel.id })
  }, [workspace, selection.channel])
  useEffect(() => {
    if (!selectedAgent) return
    const nextSelectedAgent = snapshot ? snapshotAgents(snapshot).find((agent) => agent.id === selectedAgent.id) ?? null : null
    setSelectedAgent(nextSelectedAgent)
  }, [snapshot, selectedAgent])
  const taskRepository = useMemo(() => findRepository(workspace, selectedTaskRepositoryId), [workspace, selectedTaskRepositoryId])
  const taskScope = taskRepository ?? workspace?.repositories[0]
  const selectedTask = useMemo(() => findTask(workspace, selectedTaskId) ?? (!taskRepository ? taskScope?.tasks.find((task) => task.channelId === selection.channel?.id) : null), [workspace, selectedTaskId, taskRepository, taskScope, selection])
  const composerRepository = useMemo(() => findRepository(workspace, composerRepositoryId), [workspace, composerRepositoryId])
  const messages = useMemo(() => snapshot && selection.channel ? snapshotChannelMessages(snapshot, selection.channel.id) : [], [snapshot, selection.channel])
  const agents = useMemo(() => {
    const allAgents = snapshot ? snapshotAgents(snapshot) : []
    return !selection.channel?.subscriberAgentIds ? allAgents : allAgents.filter((agent) => selection.channel!.subscriberAgentIds!.includes(agent.id))
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
  if (!workspace) return <WorkspaceSetup api={api} onComplete={refresh} />
  if (!selection.channel || !selection.repository) return <main className="workspace-loading"><p>这个工作空间还没有频道。</p></main>

  const sendMessage = async (body: string) => {
    if (selection.channel?.archivedAt) throw new Error('此频道已归档，只能查看历史记录。')
    const intent = parseMessageIntent(body, workspace.agents)
    if (intent.kind === 'error') throw new Error(intent.message)
    if (intent.kind === 'message') {
      await api.postMessage(selection.channel!.id, { body: intent.body })
      await refresh()
      return undefined
    }

    const repository = workspace.repositories[0]
    if (!repository) throw new Error('当前工作空间没有可用的代码仓。')
    const task = await api.createTask(repository.id, {
      title: intent.body,
      description: intent.body,
      acceptanceCriteria: '任务完成后在当前频道说明结果。',
      labels: [],
      directAgentId: intent.directAgentId,
      channelId: selection.channel!.id,
    })
    await refresh()
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
    const nextSelection = findSelection(snapshot, channelId)
    if (nextSelection.workspace) setSelectedWorkspaceId(nextSelection.workspace.id)
    setSelectedChannelId(channelId)
    setSelectedThreadRootId(null)
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
    setComposerRepositoryId(null)
    setChannelActionError(null)
    setNavOpen(false)
  }
  const selectTask = (repositoryId: string, taskId: string) => { setSelectedTaskRepositoryId(repositoryId); setSelectedTaskId(taskId); setContextOpen(true); setNavOpen(false) }
  const createTask = async (input: CreateTaskRequest) => {
    if (!composerRepository) throw new Error('没有可用的代码仓上下文。')
    if (selection.channel?.archivedAt) throw new Error('此频道已归档，不能创建任务。')
    const task = await api.createTask(composerRepository.id, { ...input, channelId: selection.channel!.id })
    await refresh()
    setComposerRepositoryId(null)
    setSelectedTaskRepositoryId(composerRepository.id)
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
    await api.createAgent(workspace.id, input)
    await refresh()
    setCreatingAgent(false)
  }
  const createWorkspace = async (input: { name: string; directory: string }) => {
    const nextWorkspace = await api.createWorkspace({ name: input.name })
    await api.addRepository(nextWorkspace.id, { directory: input.directory })
    await refresh()
    setSelectedWorkspaceId(nextWorkspace.id)
    setCreatingWorkspace(false)
  }
  const createChannel = async (input: { name: string }) => {
    const repository = findRepository(workspace, creatingChannelRepositoryId)
    if (!repository) throw new Error('没有可用的工作目录。')
    const channel = await api.createChannel(repository.id, input)
    await refresh()
    setSelectedChannelId(channel.id)
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
    setCreatingChannelRepositoryId(null)
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
    <RepositorySidebar workspace={workspace} workspaces={snapshot.workspaces} selectedChannelId={selection.channel.id} selectedTaskId={selectedTask?.id ?? null} onSelectChannel={selectChannel} onSelectTask={selectTask} onCreateTask={setComposerRepositoryId} onCreateChannel={setCreatingChannelRepositoryId} onArchiveChannel={archiveChannel} onRestoreChannel={restoreChannel} channelReadOnly={Boolean(selection.channel.archivedAt)} onCreateWorkspace={() => setCreatingWorkspace(true)} onSelectAgent={setSelectedAgent} onCreateAgent={() => setCreatingAgent(true)} mobileOpen={navOpen} mobileHidden={narrowNavigation && !navOpen} onClose={() => setNavOpen(false)} />
    <main className="conversation-panel">
      <header className="channel-header"><NavigationToggle onClick={() => setNavOpen(true)} /><div className="channel-heading"><h1># {selection.channel.name}</h1><p>{selection.channel.archivedAt ? '已归档频道 · 只读' : '全局频道'}</p></div><div className="header-actions"><span className="connection-state" data-reconnecting={reconnecting}>{reconnecting ? '正在重新连接' : '已连接'}</span><button type="button" className="icon-button" aria-label="打开上下文" data-tooltip="打开上下文" onClick={() => setContextOpen(true)}><PanelRightOpen size={18} /></button></div></header>
      {channelActionError && <p className="channel-action-error" role="alert">{channelActionError}</p>}
      <ChannelTimeline messages={messages} typingAgents={typingAgents} onOpenThread={(message) => { setSelectedThreadRootId(message.id); setContextOpen(true) }} />
      {selection.channel.archivedAt ? <div className="archived-channel-notice" role="status">此频道已归档，只能查看历史记录。</div> : <MessageComposer channelName={selection.channel.name} agents={agents} onSend={sendMessage} />}
    </main>
    <aside className="context-panel" aria-label="任务与上下文" aria-hidden={narrowContext && !contextOpen || undefined} inert={narrowContext && !contextOpen} data-mobile-open={contextOpen}>
      <header className="context-header"><strong>上下文</strong><button type="button" className="icon-button context-close" aria-label="关闭上下文" data-tooltip="关闭上下文" onClick={() => setContextOpen(false)}><X size={17} /></button></header>
      {threadRoot && <ThreadPanel root={threadRoot} replies={threadReplies} agents={agents} readOnly={Boolean(selection.channel.archivedAt)} onSend={sendThreadMessage} onClose={() => setSelectedThreadRootId(null)} />}
      {taskScope && <section className="context-section"><div className="context-section-heading"><h2>{taskRepository ? `${taskRepository.name} 任务` : `${workspace.name} 任务`}</h2>{!selection.channel.archivedAt && <button type="button" className="icon-button" aria-label="新建当前上下文任务" data-tooltip="新建任务" onClick={() => setComposerRepositoryId(taskScope.id)}>+</button>}</div><TaskList tasks={taskScope.tasks.filter((task) => taskRepository || task.channelId === selection.channel!.id)} selectedTaskId={selectedTask?.id ?? null} onSelect={setSelectedTaskId} /></section>}
      {selectedTask && <section className="context-section task-details-context">{taskDetails ? <TaskDetailPanel details={taskDetails} onQueueInput={(body) => queueTaskInput(taskDetails.task.id, body)} onReview={(action) => reviewTask(taskDetails.task.id, action)} onRequeue={() => requeueTask(taskDetails.task.id)} onReadArtifact={(artifactId) => api.readArtifact(taskDetails.task.id, artifactId)} /> : <p className="context-empty">{taskDetailsError ?? '正在读取任务详情...'}</p>}</section>}
      <section className="context-section"><h2>频道操作</h2><button type="button" className="context-action" onClick={() => setContextOpen(false)}><PanelRightClose size={16} /> 收起上下文</button></section>
    </aside>
    {composerRepository && <TaskComposerPanel repository={composerRepository} agents={workspace.agents} onCreate={createTask} onClose={() => setComposerRepositoryId(null)} />}
    {creatingWorkspace && <WorkspaceCreateDialog onCreate={createWorkspace} onClose={() => setCreatingWorkspace(false)} />}
    {creatingChannelRepositoryId && <ChannelCreateDialog onCreate={createChannel} onClose={() => setCreatingChannelRepositoryId(null)} />}
    {creatingAgent && <AgentCreateDialog onCreate={createAgent} onClose={() => setCreatingAgent(false)} />}
    {selectedAgent && <AgentConfigDialog agent={selectedAgent} refreshingRuntime={refreshingAgentId === selectedAgent.id} onRefreshRuntime={refreshAgentRuntime} onUpdateResponsibilities={updateAgentResponsibilities} onClose={() => setSelectedAgent(null)} />}
  </div>
}

function findSelection(snapshot: WorkspaceSnapshot | null, selectedChannelId: string | null) {
  const all = snapshot?.workspaces.flatMap((workspace) => workspace.repositories.flatMap((repository) => repository.channels.map((channel) => ({ workspace, repository, channel })))) ?? []
  return all.find((candidate) => candidate.channel.id === selectedChannelId) ?? all[0] ?? { workspace: undefined, repository: undefined, channel: undefined }
}

function findTask(workspace: WorkspaceView | undefined, taskId: string | null): TaskView | undefined {
  if (!taskId) return undefined
  return workspace?.repositories.flatMap((repository) => repository.tasks).find((task) => task.id === taskId)
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

function readStoredSelection(): { workspaceId: string; channelId: string } | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(selectionStorageKey) ?? 'null')
    if (!value || typeof value !== 'object' || !('workspaceId' in value) || !('channelId' in value)) return undefined
    const { workspaceId, channelId } = value as { workspaceId?: unknown; channelId?: unknown }
    return typeof workspaceId === 'string' && typeof channelId === 'string' ? { workspaceId, channelId } : undefined
  } catch {
    return undefined
  }
}

function storeSelection(selection: { workspaceId: string; channelId: string }): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(selectionStorageKey, JSON.stringify(selection))
}
