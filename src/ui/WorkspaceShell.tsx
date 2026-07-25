import { PanelRightClose, PanelRightOpen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CreateAgentRequest, CreateTaskRequest, WorkspaceApi } from '../api/client'
import { ApiClient } from '../api/client'
import { useWorkspaceEvents } from '../api/use-workspace-events'
import { channelMessages, type AgentView, type RepositoryView, type TaskDetailView, type TaskView, type WorkspaceSnapshot, type WorkspaceView } from '../domain/workspace-view'
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

export function WorkspaceShell({ api: providedApi }: { api?: WorkspaceApi }) {
  const [defaultApi] = useState(() => new ApiClient())
  const api = providedApi ?? defaultApi
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskRepositoryId, setSelectedTaskRepositoryId] = useState<string | null>(null)
  const [taskDetails, setTaskDetails] = useState<TaskDetailView | null>(null)
  const [taskDetailsError, setTaskDetailsError] = useState<string | null>(null)
  const [composerRepositoryId, setComposerRepositoryId] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<AgentView | null>(null)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [creatingChannelRepositoryId, setCreatingChannelRepositoryId] = useState<string | null>(null)
  const [refreshingAgentId, setRefreshingAgentId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
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

  const workspace = snapshot?.workspaces.find((candidate) => candidate.id === selectedWorkspaceId) ?? snapshot?.workspaces[0]
  const selection = useMemo(() => findSelection(workspace, selectedChannelId), [workspace, selectedChannelId])
  useEffect(() => { if (selection.channel && selectedChannelId !== selection.channel.id) setSelectedChannelId(selection.channel.id) }, [selection.channel, selectedChannelId])
  useEffect(() => {
    if (!selectedAgent) return
    const nextSelectedAgent = workspace?.agents.find((agent) => agent.id === selectedAgent.id) ?? null
    setSelectedAgent(nextSelectedAgent)
  }, [workspace, selectedAgent])
  const taskRepository = useMemo(() => findRepository(workspace, selectedTaskRepositoryId), [workspace, selectedTaskRepositoryId])
  const taskScope = taskRepository ?? selection.repository
  const selectedTask = useMemo(() => findTask(workspace, selectedTaskId) ?? (!taskRepository ? selection.repository?.tasks.find((task) => task.channelId === selection.channel?.id) : null), [workspace, selectedTaskId, taskRepository, selection])
  const composerRepository = useMemo(() => findRepository(workspace, composerRepositoryId), [workspace, composerRepositoryId])

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
    const intent = parseMessageIntent(body, workspace.agents)
    if (intent.kind === 'error') throw new Error(intent.message)
    if (intent.kind === 'message') {
      await api.postMessage(selection.channel!.id, { body: intent.body })
      await refresh()
      return undefined
    }

    const task = await api.createTask(selection.repository!.id, {
      title: intent.body,
      description: intent.body,
      acceptanceCriteria: '任务完成后在当前频道说明结果。',
      labels: [],
      directAgentId: intent.directAgentId,
      channelId: selection.channel!.id,
    })
    await refresh()
    setSelectedTaskRepositoryId(selection.repository!.id)
    setSelectedTaskId(task.id)
    setContextOpen(true)
    return { notice: '任务已派发。' }
  }
  const selectChannel = (channelId: string) => { setSelectedChannelId(channelId); setSelectedTaskId(null); setSelectedTaskRepositoryId(null); setComposerRepositoryId(null); setNavOpen(false) }
  const selectWorkspace = (workspaceId: string) => {
    const nextWorkspace = snapshot.workspaces.find((candidate) => candidate.id === workspaceId)
    setSelectedWorkspaceId(workspaceId)
    setSelectedChannelId(nextWorkspace?.repositories.flatMap((repository) => repository.channels)[0]?.id ?? null)
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
    setComposerRepositoryId(null)
    setNavOpen(false)
  }
  const selectTask = (repositoryId: string, taskId: string) => { setSelectedTaskRepositoryId(repositoryId); setSelectedTaskId(taskId); setContextOpen(true); setNavOpen(false) }
  const createTask = async (input: CreateTaskRequest) => {
    if (!composerRepository) throw new Error('没有可用的代码仓上下文。')
    const task = await api.createTask(composerRepository.id, input)
    await refresh()
    setComposerRepositoryId(null)
    setSelectedTaskRepositoryId(composerRepository.id)
    setSelectedTaskId(task.id)
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
  return <div className="workspace-shell">
    <RepositorySidebar workspace={workspace} workspaces={snapshot.workspaces} selectedChannelId={selection.channel.id} selectedTaskId={selectedTask?.id ?? null} onSelectWorkspace={selectWorkspace} onSelectChannel={selectChannel} onSelectTask={selectTask} onCreateTask={setComposerRepositoryId} onCreateChannel={setCreatingChannelRepositoryId} onCreateWorkspace={() => setCreatingWorkspace(true)} onSelectAgent={setSelectedAgent} onCreateAgent={() => setCreatingAgent(true)} mobileOpen={navOpen} mobileHidden={narrowNavigation && !navOpen} onClose={() => setNavOpen(false)} />
    <main className="conversation-panel">
      <header className="channel-header"><NavigationToggle onClick={() => setNavOpen(true)} /><div className="channel-heading"><h1># {selection.channel.name}</h1><p>{selection.repository.name} · {selection.repository.currentBranch}</p></div><div className="header-actions"><span className="connection-state" data-reconnecting={reconnecting}>{reconnecting ? '正在重新连接' : '已连接'}</span><button type="button" className="icon-button" aria-label="打开上下文" data-tooltip="打开上下文" onClick={() => setContextOpen(true)}><PanelRightOpen size={18} /></button></div></header>
      <ChannelTimeline messages={channelMessages(workspace, selection.channel.id)} />
      <MessageComposer channelName={selection.channel.name} onSend={sendMessage} />
    </main>
    <aside className="context-panel" aria-label="任务与上下文" aria-hidden={narrowContext && !contextOpen || undefined} inert={narrowContext && !contextOpen} data-mobile-open={contextOpen}>
      <header className="context-header"><strong>上下文</strong><button type="button" className="icon-button context-close" aria-label="关闭上下文" data-tooltip="关闭上下文" onClick={() => setContextOpen(false)}><X size={17} /></button></header>
      <section className="context-section"><div className="context-section-heading"><h2>{taskRepository ? `${taskRepository.name} 任务` : '本频道任务'}</h2><button type="button" className="icon-button" aria-label="新建当前上下文任务" data-tooltip="新建任务" onClick={() => setComposerRepositoryId(taskScope.id)}>+</button></div><TaskList tasks={taskScope.tasks.filter((task) => taskRepository || task.channelId === selection.channel!.id)} selectedTaskId={selectedTask?.id ?? null} onSelect={setSelectedTaskId} /></section>
      {selectedTask && <section className="context-section task-details-context">{taskDetails ? <TaskDetailPanel details={taskDetails} onQueueInput={(body) => queueTaskInput(taskDetails.task.id, body)} onReview={(action) => reviewTask(taskDetails.task.id, action)} onRequeue={() => requeueTask(taskDetails.task.id)} onReadArtifact={(artifactId) => api.readArtifact(taskDetails.task.id, artifactId)} /> : <p className="context-empty">{taskDetailsError ?? '正在读取任务详情...'}</p>}</section>}
      <section className="context-section"><h2>频道操作</h2><button type="button" className="context-action" onClick={() => setContextOpen(false)}><PanelRightClose size={16} /> 收起上下文</button></section>
    </aside>
    {composerRepository && <TaskComposerPanel repository={composerRepository} agents={workspace.agents} onCreate={createTask} onClose={() => setComposerRepositoryId(null)} />}
    {creatingWorkspace && <WorkspaceCreateDialog onCreate={createWorkspace} onClose={() => setCreatingWorkspace(false)} />}
    {creatingChannelRepositoryId && <ChannelCreateDialog onCreate={createChannel} onClose={() => setCreatingChannelRepositoryId(null)} />}
    {creatingAgent && <AgentCreateDialog onCreate={createAgent} onClose={() => setCreatingAgent(false)} />}
    {selectedAgent && <AgentConfigDialog agent={selectedAgent} refreshingRuntime={refreshingAgentId === selectedAgent.id} onRefreshRuntime={refreshAgentRuntime} onClose={() => setSelectedAgent(null)} />}
  </div>
}

function findSelection(workspace: WorkspaceView | undefined, selectedChannelId: string | null) {
  const all = workspace?.repositories.flatMap((repository) => repository.channels.map((channel) => ({ repository, channel }))) ?? []
  return all.find((candidate) => candidate.channel.id === selectedChannelId) ?? all[0] ?? { repository: undefined, channel: undefined }
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
