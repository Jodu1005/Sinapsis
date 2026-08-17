import { PanelRightOpen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CreateAgentRequest, WorkspaceApi } from '../api/client'
import { ApiClient } from '../api/client'
import { useWorkspaceEvents } from '../api/use-workspace-events'
import { snapshotAgents, snapshotChannelMessages, type AgentView, type ChannelMessage, type ConversationTurnDetailView, type TaskBoardLane, type TaskDetailView, type TaskView, type TurnActivityView, type WorkspaceSnapshot } from '../domain/workspace-view'
import { parseMessageIntent } from '../domain/message-intent'
import { AgentConfigDialog } from './AgentConfigDialog'
import { AgentCreateDialog } from './AgentCreateDialog'
import { ChannelTimeline } from './ChannelTimeline'
import { MessageComposer } from './MessageComposer'
import { NavigationToggle, RepositorySidebar } from './RepositorySidebar'
import { TaskComposerPanel, type TaskComposerInput } from './TaskComposerPanel'
import { TaskDetailDialog } from './TaskDetailDialog'
import { TaskBoard } from './TaskBoard'
import { WorkspaceSetup } from './WorkspaceSetup'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog'
import { ChannelCreateDialog } from './ChannelCreateDialog'
import { ThreadPanel } from './ThreadPanel'
import { ChannelAgentMembers } from './ChannelAgentMembers'
import { ConversationTurnDetail } from './ConversationTurnDetail'
import { DreamCenter } from './DreamCenter'

export function WorkspaceShell({ api: providedApi }: { api?: WorkspaceApi }) {
  const [defaultApi] = useState(() => new ApiClient())
  const api = providedApi ?? defaultApi
  const [storedSelection] = useState(readStoredSelection)
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(storedSelection?.channelId ?? null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskRepositoryId, setSelectedTaskRepositoryId] = useState<string | null>(null)
  const [taskDetails, setTaskDetails] = useState<TaskDetailView | null>(null)
  const [taskDetailsError, setTaskDetailsError] = useState<string | null>(null)
  const [taskDetailDialogOpen, setTaskDetailDialogOpen] = useState(false)
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
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [turnDetails, setTurnDetails] = useState<ConversationTurnDetailView | null>(null)
  const [turnDetailsErrorsByKey, setTurnDetailsErrorsByKey] = useState<Map<string, TurnDetailsError>>(() => new Map())
  const [retryingTurnKeys, setRetryingTurnKeys] = useState<Set<string>>(() => new Set())
  const [confirmedCancelledTurnKeys, setConfirmedCancelledTurnKeys] = useState<Set<string>>(() => new Set())
  const turnDetailsInFlight = useRef(new Map<string, Promise<ConversationTurnDetailView | null>>())
  const pendingTurnDetailsRefresh = useRef(new Set<string>())
  const turnRequestErrors = useRef(new Map<string, Error>())
  const suppressedSnapshotTurnRefreshes = useRef(new WeakMap<WorkspaceSnapshot, string>())
  const selectedTurnRef = useRef<{ channelId: string; turnId: string } | null>(null)
  const previousSnapshotRef = useRef<WorkspaceSnapshot | null>(null)
  const [mainView, setMainView] = useState<'channel' | 'dream' | 'tasks'>('channel')
  const [pendingMessageFocusId, setPendingMessageFocusId] = useState<string | null>(null)
  const [pendingThreadFocusId, setPendingThreadFocusId] = useState<string | null>(null)
  const [sourceMessages, setSourceMessages] = useState<Map<string, ChannelMessage>>(() => new Map())
  const narrowNavigation = useMediaQuery('(max-width: 700px)')
  const narrowContext = useMediaQuery('(max-width: 980px)')
  const refresh = useCallback(async (suppressTurnRefreshKey?: string) => {
    try {
      const nextSnapshot = await api.getBootstrap()
      if (suppressTurnRefreshKey) suppressedSnapshotTurnRefreshes.current.set(nextSnapshot, suppressTurnRefreshKey)
      setSnapshot(nextSnapshot)
      setRefreshGeneration((current) => current + 1)
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
  useEffect(() => {
    if (mainView !== 'channel' || !pendingMessageFocusId) return undefined
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`message-${pendingMessageFocusId}`)
      target?.scrollIntoView?.({ block: 'center' })
      setPendingMessageFocusId(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [mainView, pendingMessageFocusId, selection.channel?.id, snapshot])
  useEffect(() => {
    if (mainView !== 'channel' || !pendingThreadFocusId || !selectedThreadRootId) return undefined
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`message-${pendingThreadFocusId}`)
      target?.scrollIntoView?.({ block: 'center' })
      target?.focus?.()
      setPendingThreadFocusId(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [mainView, pendingThreadFocusId, selectedThreadRootId, snapshot])
  const taskBoardTasks = snapshot?.tasks ?? []
  const taskSelectionChannel = mainView === 'tasks' ? undefined : selection.channel
  const taskSelectionWorkspaceIds = mainView === 'tasks'
    ? snapshot?.workspaces.map((workspace) => workspace.id) ?? []
    : selection.channel?.boundWorkspaceIds ?? []
  const selectedTask = useMemo(
    () => findTask(snapshot, selectedTaskId, taskSelectionChannel?.id, taskSelectionWorkspaceIds),
    [snapshot, selectedTaskId, taskSelectionChannel, taskSelectionWorkspaceIds],
  )
  const readSelectedTaskArtifact = useCallback(async (artifactId: string) => {
    if (!selectedTask) throw new Error('任务已关闭。')
    return api.readArtifact(selectedTask.id, artifactId)
  }, [api, selectedTask?.id])
  const listTaskOutputFiles = useCallback((taskId: string) => api.listTaskOutputFiles(taskId), [api])
  const readTaskOutputFile = useCallback((taskId: string, filePath: string) => api.readTaskOutputFile(taskId, filePath), [api])
  useEffect(() => {
    if (!snapshot || !selectedTaskId || selectedTask) return
    setSelectedTaskId(null)
    setSelectedTaskRepositoryId(null)
    setTaskDetailDialogOpen(false)
  }, [snapshot, selectedTaskId, selectedTask])
  const messages = useMemo(() => {
    if (!selection.channel) return []
    const merged = new Map((snapshot ? snapshotChannelMessages(snapshot, selection.channel.id) : []).map((message) => [message.id, message]))
    for (const message of sourceMessages.values()) if (message.channelId === selection.channel.id) merged.set(message.id, message)
    return [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }, [snapshot, selection.channel, sourceMessages])
  const allAgents = useMemo(() => snapshot ? snapshotAgents(snapshot) : [], [snapshot])
  const channelAgents = useMemo(() => selection.channel
    ? allAgents.filter((agent) => selection.channel!.memberAgentIds.includes(agent.id))
    : allAgents, [allAgents, selection.channel])
  const turnActivities: TurnActivityView[] = useMemo(() => selection.channel ? snapshot?.activeTurnsByChannel?.[selection.channel.id] ?? [] : [], [selection.channel, snapshot])
  const activeTurnIds = useMemo(() => [...new Set(turnActivities.map((activity) => activity.turnId))], [turnActivities])
  const turnResults = useMemo(() => selection.channel ? snapshot?.recentTurnResultsByChannel?.[selection.channel.id] ?? [] : [], [selection.channel, snapshot])
  const threadRoot = useMemo(() => selectedThreadRootId ? messages.find((message) => message.id === selectedThreadRootId && !message.threadRootMessageId) : undefined, [messages, selectedThreadRootId])
  const threadReplies = useMemo(() => threadRoot ? messages.filter((message) => message.threadRootMessageId === threadRoot.id) : [], [messages, threadRoot])
  const selectedTurnChannelId = selection.channel?.id ?? null
  useEffect(() => {
    selectedTurnRef.current = selectedTurnChannelId && selectedTurnId ? { channelId: selectedTurnChannelId, turnId: selectedTurnId } : null
  }, [selectedTurnChannelId, selectedTurnId])
  const setTurnDetailsError = useCallback((key: string, error: TurnDetailsError | null) => {
    setTurnDetailsErrorsByKey((current) => {
      const next = new Map(current)
      if (error) next.set(key, error)
      else next.delete(key)
      return next
    })
  }, [])
  const clearTurnDetailsError = useCallback((key: string, source?: TurnDetailsError['source']) => {
    setTurnDetailsErrorsByKey((current) => {
      if (!current.has(key) || source && current.get(key)?.source !== source) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
  }, [])
  const loadConversationTurn = useCallback(async (channelId: string, turnId: string, clearExisting: boolean): Promise<ConversationTurnDetailView | null> => {
    const requestKey = `${channelId}:${turnId}`
    if (clearExisting) {
      setTurnDetails((current) => current?.turn.channelId === channelId && current.turn.id === turnId ? current : null)
    }
    const existingRequest = turnDetailsInFlight.current.get(requestKey)
    if (existingRequest) {
      pendingTurnDetailsRefresh.current.add(requestKey)
      const existingDetails = await existingRequest
      if (!pendingTurnDetailsRefresh.current.delete(requestKey)) return existingDetails
      if (turnDetailsInFlight.current.get(requestKey) === existingRequest) turnDetailsInFlight.current.delete(requestKey)
      return loadConversationTurn(channelId, turnId, false)
    }
    clearTurnDetailsError(requestKey, 'detail')
    const promise = (async () => {
      let latestDetails: ConversationTurnDetailView | null = null
      while (true) {
        pendingTurnDetailsRefresh.current.delete(requestKey)
        try {
          const details = await api.getConversationTurn(channelId, turnId)
          const selected = selectedTurnRef.current
          latestDetails = details
          turnRequestErrors.current.delete(requestKey)
          clearTurnDetailsError(requestKey, 'detail')
          if (selected?.channelId === channelId && selected.turnId === turnId) {
            setTurnDetails(details)
          }
        } catch (cause) {
          const detailsError = cause instanceof Error ? cause : new Error('无法读取 Turn 详情。')
          latestDetails = null
          turnRequestErrors.current.set(requestKey, detailsError)
          setTurnDetailsError(requestKey, { key: requestKey, source: 'detail', message: detailsError.message })
        }
        const selected = selectedTurnRef.current
        if (!pendingTurnDetailsRefresh.current.has(requestKey)
          || selected?.channelId !== channelId
          || selected.turnId !== turnId) break
      }
      return latestDetails
    })()
    turnDetailsInFlight.current.set(requestKey, promise)
    try {
      return await promise
    } finally {
      if (turnDetailsInFlight.current.get(requestKey) === promise) turnDetailsInFlight.current.delete(requestKey)
    }
  }, [api, clearTurnDetailsError, setTurnDetailsError])

  useEffect(() => {
    if (!selectedTask) { setTaskDetails(null); setTaskDetailsError(null); return undefined }
    let active = true
    setTaskDetails((current) => current?.task.id === selectedTask.id ? current : null)
    setTaskDetailsError(null)
    void api.getTaskDetails(selectedTask.id).then(
      (details) => { if (active) setTaskDetails(details) },
      (cause: unknown) => { if (active) setTaskDetailsError(cause instanceof Error ? cause.message : '无法读取任务详情。') },
    )
    return () => { active = false }
  }, [api, selectedTask?.id, snapshot])
  useEffect(() => {
    if (!selectedTask || selectedTask.status !== 'backlog' || !taskDetails?.comments?.some((comment) => comment.senderType === 'system' && comment.body.startsWith('积压分析暂未完成：'))) return
    let active = true
    void api.getTaskDetails(selectedTask.id).then((details) => {
      if (active) setTaskDetails(details)
    })
    return () => { active = false }
  }, [api, selectedTask?.id, selectedTask?.status, taskDetails?.comments?.length])
  useEffect(() => {
    if (!selectedTurnChannelId || !selectedTurnId) {
      pendingTurnDetailsRefresh.current.clear()
      turnRequestErrors.current.clear()
      setTurnDetails(null)
      return
    }
    void loadConversationTurn(selectedTurnChannelId, selectedTurnId, true)
  }, [loadConversationTurn, selectedTurnChannelId, selectedTurnId])
  useEffect(() => {
    const previousSnapshot = previousSnapshotRef.current
    previousSnapshotRef.current = snapshot
    if (!snapshot || !previousSnapshot || previousSnapshot === snapshot) return
    const selected = selectedTurnRef.current
    if (!selected) return
    const suppressedTurnKey = suppressedSnapshotTurnRefreshes.current.get(snapshot)
    suppressedSnapshotTurnRefreshes.current.delete(snapshot)
    if (suppressedTurnKey === `${selected.channelId}:${selected.turnId}`) return
    void loadConversationTurn(selected.channelId, selected.turnId, false)
  }, [loadConversationTurn, snapshot])

  if (!snapshot) return <main className="workspace-loading"><p>{error ?? '正在连接本机工作空间...'}</p>{error && <button type="button" onClick={refreshInBackground}>重试</button>}</main>
  if (snapshot.workspaces.length === 0) return <WorkspaceSetup api={api} onComplete={refresh} />
  if (!selection.channel) return <main className="workspace-loading"><p>还没有频道。</p></main>

  const sendMessage = async (body: string) => {
    if (selection.channel?.archivedAt) throw new Error('此频道已归档，只能查看历史记录。')
    const intent = parseMessageIntent(body, channelAgents)
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
  const stopActiveChannelTurns = async () => {
    const channelId = selection.channel?.id
    if (!channelId || activeTurnIds.length === 0) return
    await Promise.all(activeTurnIds.map((turnId) => api.cancelConversationTurn(channelId, turnId)))
    await refresh()
  }
  const selectChannel = (channelId: string) => {
    setMainView('channel')
    setSelectedChannelId(channelId)
    setSelectedWorkspaceId(null)
    setSelectedThreadRootId(null)
    setSelectedTurnId(null)
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
    setTaskDetailDialogOpen(false)
  }
  const selectTask = (repositoryId: string, taskId: string) => { setSelectedTaskRepositoryId(repositoryId); setSelectedTaskId(taskId); setTaskDetailDialogOpen(true); setContextOpen(true); setNavOpen(false) }
  const openBoardTask = (taskId: string) => {
    const task = taskBoardTasks.find((candidate) => candidate.id === taskId)
    if (!task) return
    setSelectedWorkspaceId(task.workspaceId)
    setSelectedTaskRepositoryId(task.repositoryId)
    setSelectedTaskId(task.id)
    setTaskDetailDialogOpen(true)
    setContextOpen(true)
  }
  const addTaskComment = async (task: TaskView, body: string) => {
    await api.postMessage(task.channelId, { body, taskId: task.id, threadRootMessageId: task.threadRootMessageId ?? undefined })
    const details = await api.getTaskDetails(task.id)
    setTaskDetails(details)
    await refresh()
  }
  const retryTaskAnalysis = async (task: TaskView) => {
    const knownCommentIds = new Set(taskDetails?.task.id === task.id ? (taskDetails.comments ?? []).map((comment) => comment.id) : [])
    await api.retryTaskAnalysis(task.id)
    void watchTaskAnalysis(task.id, knownCommentIds)
    await refresh()
  }
  const watchTaskAnalysis = async (taskId: string, knownCommentIds: Set<string>) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(1_000)
      try {
        const details = await api.getTaskDetails(taskId)
        setTaskDetails((current) => current?.task.id === taskId ? details : current)
        if ((details.comments ?? []).some((comment) => !knownCommentIds.has(comment.id) && (comment.senderType === 'agent' || comment.senderType === 'system'))) {
          await refresh()
          return
        }
      } catch {
        return
      }
    }
  }
  const createTask = async (input: TaskComposerInput, channelId: string) => {
    const taskChannel = snapshot.channels.find((candidate) => candidate.id === channelId)
    if (!taskChannel) throw new Error('请选择频道。')
    if (taskChannel.archivedAt) throw new Error('此频道已归档，不能创建任务。')
    let taskWorkspace = input.workspaceId ? snapshot.workspaces.find((candidate) => candidate.id === input.workspaceId) : undefined
    if (!taskWorkspace && input.directory) {
      taskWorkspace = snapshot.workspaces.find((candidate) => candidate.repositories.some((repository) => repository.path === input.directory))
      if (!taskWorkspace) {
        const createdWorkspace = await api.createWorkspace({ name: workspaceNameFromDirectory(input.directory) })
        const createdRepository = await api.addRepository(createdWorkspace.id, { directory: input.directory })
        taskWorkspace = { ...createdWorkspace, repositories: [createdRepository] }
      }
    }
    const repository = taskWorkspace?.repositories[0]
    if (!taskWorkspace || !repository) throw new Error('没有可用的工作目录。')
    if (!taskChannel.boundWorkspaceIds.includes(taskWorkspace.id)) {
      await api.bindChannelWorkspace(taskChannel.id, taskWorkspace.id)
    }
    const { directory: _directory, workspaceId: _workspaceId, ...taskInput } = input
    const task = await api.createTask(taskChannel.id, { ...taskInput, workspaceId: taskWorkspace.id })
    await refresh()
    setTaskComposerDraft(null)
    setSelectedWorkspaceId(taskWorkspace.id)
    setSelectedTaskRepositoryId(repository.id)
    setSelectedTaskId(task.id)
    setTaskDetailDialogOpen(true)
    setSelectedThreadRootId(task.threadRootMessageId ?? null)
    setContextOpen(true)
    return task
  }
  const queueTaskInput = async (taskId: string, body: string) => {
    const queued = await api.queueTaskInput(taskId, body)
    setTaskDetails((details) => details?.task.id === taskId ? { ...details, inputs: [...details.inputs, queued] } : details)
  }
  const reviewTask = async (taskId: string, action: 'accept' | 'return', message: string) => {
    const task = await api.reviewTask(taskId, action, message)
    setTaskDetails((details) => details?.task.id === taskId ? { ...details, task } : details)
    await refresh()
  }
  const moveTask = async (taskId: string, lane: TaskBoardLane, message?: string) => {
    const task = await api.moveTask(taskId, lane, message)
    setSelectedTaskRepositoryId(task.repositoryId)
    setSelectedTaskId(task.id)
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
  const updateAgentIdentity = async (identity: string) => {
    if (!selectedAgent) return
    const updated = await api.updateAgentIdentity(selectedAgent.id, identity)
    setSelectedAgent(updated)
    await refresh()
  }
  const updateAgentModel = async (model: string) => {
    if (!selectedAgent) return
    const updated = await api.updateAgentModel(selectedAgent.id, model)
    setSelectedAgent(updated)
    await refresh()
  }
  const cancelSelectedTurn = async () => {
    if (!selectedTurnChannelId || !selectedTurnId) throw new Error('无法取消当前 Turn。')
    const channelId = selectedTurnChannelId
    const turnId = selectedTurnId
    await api.cancelConversationTurn(channelId, turnId)
    const turnKey = `${channelId}:${turnId}`
    setConfirmedCancelledTurnKeys((current) => new Set(current).add(turnKey))
    setTurnDetails((details) => details?.turn.id === turnId
      ? { ...details, turn: { ...details.turn, status: 'cancelled' } }
      : details)
    try {
      await refresh(turnKey)
    } catch (cause) {
      const refreshError = cause instanceof Error ? cause : new Error('工作空间刷新失败。')
      setTurnDetailsError(turnKey, { key: turnKey, source: 'bootstrap', message: `Turn 已取消，但工作空间刷新失败：${refreshError.message}` })
      throw cause
    }
    const refreshedDetails = await loadConversationTurn(channelId, turnId, false)
    if (!refreshedDetails) {
      const reason = turnRequestErrors.current.get(turnKey)?.message ?? '无法读取最新详情。'
      const refreshError = new Error(`Turn 已取消，但详情刷新失败：${reason}`)
      setTurnDetailsError(turnKey, { key: turnKey, source: 'detail', message: refreshError.message })
      throw refreshError
    }
  }
  const retrySelectedTurnDetails = async () => {
    const selected = selectedTurnRef.current
    if (!selected) return
    const turnKey = `${selected.channelId}:${selected.turnId}`
    if (retryingTurnKeys.has(turnKey)) return
    const currentError = turnDetailsErrorsByKey.get(turnKey) ?? null
    setRetryingTurnKeys((current) => new Set(current).add(turnKey))
    try {
      if (currentError?.source === 'bootstrap') {
        await refresh(turnKey)
      }
      const details = await loadConversationTurn(selected.channelId, selected.turnId, false)
      if (!details) throw turnRequestErrors.current.get(turnKey) ?? new Error('无法读取最新详情。')
      setTurnDetailsError(turnKey, null)
    } catch (cause) {
      const retryError = cause instanceof Error ? cause : new Error('无法刷新 Turn 详情。')
      setTurnDetailsError(turnKey, { key: turnKey, source: currentError?.source ?? 'detail', message: retryError.message })
    } finally {
      setRetryingTurnKeys((current) => {
        const next = new Set(current)
        next.delete(turnKey)
        return next
      })
    }
  }
  const selectedTurnKey = selectedTurnChannelId && selectedTurnId ? `${selectedTurnChannelId}:${selectedTurnId}` : null
  const selectedTurnDetailsError = selectedTurnKey ? turnDetailsErrorsByKey.get(selectedTurnKey) ?? null : null
  const retryingSelectedTurn = selectedTurnKey ? retryingTurnKeys.has(selectedTurnKey) : false
  const matchingTurnDetails = turnDetails?.turn.channelId === selectedTurnChannelId && turnDetails.turn.id === selectedTurnId ? turnDetails : null
  const displayedTurnDetails = matchingTurnDetails && selectedTurnKey && confirmedCancelledTurnKeys.has(selectedTurnKey)
    ? { ...matchingTurnDetails, turn: { ...matchingTurnDetails.turn, status: 'cancelled' as const } }
    : matchingTurnDetails
  const jumpToDreamSource = async (channelId: string, messageId: string) => {
    try {
      const source = await api.getChannelMessage(channelId, messageId)
      selectChannel(channelId)
      setSourceMessages((current) => {
        const next = new Map(current)
        next.set(source.message.id, source.message)
        if (source.threadRoot) next.set(source.threadRoot.id, source.threadRoot)
        return next
      })
      const rootId = source.threadRoot?.id ?? source.message.id
      setPendingMessageFocusId(rootId)
      if (source.threadRoot) {
        setSelectedThreadRootId(source.threadRoot.id)
        setPendingThreadFocusId(source.message.id)
        setContextOpen(true)
      }
    } catch (cause) {
      setChannelActionError(cause instanceof Error ? cause.message : '无法读取来源消息。')
    }
  }
  return <div className={`workspace-shell${mainView === 'dream' ? ' dream-view' : mainView === 'tasks' ? ' task-board-view' : ''}`}>
    <RepositorySidebar workspaces={snapshot.workspaces} agents={allAgents} channels={snapshot.channels} tasks={snapshot.tasks} selectedChannelId={selection.channel.id} selectedWorkspaceId={workspace?.id ?? null} selectedTaskId={selectedTask?.id ??null} onSelectChannel={selectChannel} onSelectWorkspace={selectWorkspace} onSelectTask={selectTask} onCreateTask={(workspaceId) => setTaskComposerDraft({ initialWorkspaceId: workspaceId })} onCreateChannel={() => setCreatingChannel(true)} onArchiveChannel={archiveChannel} onRestoreChannel={restoreChannel} channelReadOnly={Boolean(selection.channel.archivedAt)} onCreateWorkspace={() => setCreatingWorkspace(true)} onSelectAgent={setSelectedAgent} onCreateAgent={() => setCreatingAgent(true)} pendingMemoryCandidateCount={snapshot.pendingMemoryCandidateCount} dreamSelected={mainView === 'dream'} onSelectDream={() => { setMainView('dream'); setNavOpen(false) }} tasksSelected={mainView === 'tasks'} onSelectTasks={() => { setMainView('tasks'); setNavOpen(false) }} mobileOpen={navOpen} mobileHidden={narrowNavigation && !navOpen} onClose={() => setNavOpen(false)} />
    {mainView === 'dream' ? <DreamCenter api={api} channels={snapshot.channels} onJumpToSource={jumpToDreamSource} refreshGeneration={refreshGeneration} onOpenNavigation={() => setNavOpen(true)} /> : <>{mainView === 'tasks' ? <main className="task-board-panel">
      <header className="task-board-header"><NavigationToggle onClick={() => setNavOpen(true)} /><div className="channel-heading"><h1>任务看板</h1></div><button type="button" className="primary-action" onClick={() => setTaskComposerDraft({ channelId: selection.channel.id, initialWorkspaceId: selection.channel.boundWorkspaceIds[0] })}>新建任务</button></header>
      <TaskBoard tasks={taskBoardTasks} agents={allAgents} selectedTaskId={selectedTask?.id ?? null} readOnly={false} onSelect={openBoardTask} onMove={moveTask} />
    </main> : <main className="conversation-panel">
      <header className="channel-header"><NavigationToggle onClick={() => setNavOpen(true)} /><div className="channel-heading"><h1># {selection.channel.name}</h1><p>{selection.channel.archivedAt ? '已归档频道 · 只读' : '全局频道'}</p></div><div className="header-actions"><span className="connection-state" data-reconnecting={reconnecting}>{reconnecting ? '正在重新连接' : '已连接'}</span><button type="button" className="icon-button" aria-label="打开上下文" data-tooltip="打开上下文" onClick={() => setContextOpen(true)}><PanelRightOpen size={18} /></button></div></header>
      {channelActionError && <p className="channel-action-error" role="alert">{channelActionError}</p>}
      <ChannelTimeline messages={messages} agents={channelAgents} turnActivities={turnActivities} turnResults={turnResults} onOpenThread={(message) => { setSelectedThreadRootId(message.id); setSelectedTurnId(null); setContextOpen(true) }} onOpenTurn={(turnId) => { setSelectedTurnId(turnId); setSelectedThreadRootId(null); setContextOpen(true) }} />
      {selection.channel.archivedAt ? <div className="archived-channel-notice" role="status">此频道已归档，只能查看历史记录。</div> : <MessageComposer channelName={selection.channel.name} agents={channelAgents} onSend={sendMessage} onStop={activeTurnIds.length > 0 ? stopActiveChannelTurns : undefined} />}
    </main>}
    <aside className="context-panel" aria-label="任务与上下文" aria-hidden={narrowContext && !contextOpen || undefined} inert={narrowContext && !contextOpen} data-mobile-open={contextOpen}>
      <header className="context-header"><strong>上下文</strong><button type="button" className="icon-button context-close" aria-label="关闭上下文" data-tooltip="关闭上下文" onClick={() => setContextOpen(false)}><X size={17} /></button></header>
      {threadRoot && <ThreadPanel root={threadRoot} replies={threadReplies} agents={channelAgents} readOnly={Boolean(selection.channel.archivedAt)} onSend={sendThreadMessage} onClose={() => setSelectedThreadRootId(null)} />}
      {selectedTurnId && <section className="context-section turn-details-context">
        {selectedTurnDetailsError && <div className="turn-detail-refresh-error" role="alert"><span>{selectedTurnDetailsError.message}</span><button type="button" className="secondary-action" disabled={retryingSelectedTurn} onClick={() => void retrySelectedTurnDetails()}>{retryingSelectedTurn ? '正在重试...' : '重试 Turn 详情'}</button></div>}
        {displayedTurnDetails ? <ConversationTurnDetail key={displayedTurnDetails.turn.id} detail={displayedTurnDetails} agents={channelAgents} onCancel={cancelSelectedTurn} /> : !selectedTurnDetailsError && <p className="context-empty">正在读取 Turn 详情...</p>}
      </section>}
      <ChannelAgentMembers channel={selection.channel} agents={allAgents} api={api} onChanged={refresh} />
    </aside></>}
    {taskComposerDraft && <TaskComposerPanel workspaces={snapshot.workspaces} channels={snapshot.channels} agents={snapshotAgents(snapshot)} initialChannelId={taskComposerDraft.channelId ?? selection.channel.id} initialWorkspaceId={taskComposerDraft.initialWorkspaceId} initialTitle={taskComposerDraft.initialTitle} initialDirectAgentId={taskComposerDraft.initialDirectAgentId} onBrowseDirectory={() => api.pickDirectory()} onCreate={createTask} onClose={() => setTaskComposerDraft(null)} />}
    {taskDetailDialogOpen && selectedTask && <TaskDetailDialog task={selectedTask} details={taskDetails} agents={snapshot ? snapshotAgents(snapshot) : []} error={taskDetailsError} onComment={(body) => addTaskComment(selectedTask, body)} onRetryAnalysis={() => retryTaskAnalysis(selectedTask)} onReadArtifact={readSelectedTaskArtifact} onListOutputFiles={listTaskOutputFiles} onReadOutputFile={readTaskOutputFile} onClose={() => setTaskDetailDialogOpen(false)} />}
    {creatingWorkspace && <WorkspaceCreateDialog onCreate={createWorkspace} onClose={() => setCreatingWorkspace(false)} />}
    {creatingChannel && <ChannelCreateDialog onCreate={createChannel} onClose={() => setCreatingChannel(false)} />}
    {creatingAgent && <AgentCreateDialog onCreate={createAgent} onClose={() => setCreatingAgent(false)} />}
    {selectedAgent && <AgentConfigDialog agent={selectedAgent} refreshingRuntime={refreshingAgentId === selectedAgent.id} onRefreshRuntime={refreshAgentRuntime} onUpdateIdentity={updateAgentIdentity} onUpdateModel={updateAgentModel} onUpdateResponsibilities={updateAgentResponsibilities} onClose={() => setSelectedAgent(null)} />}
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
  if (!taskId) return undefined
  return snapshot?.tasks.find((task) =>
    task.id === taskId
    && (!channelId || task.channelId === channelId)
    && boundWorkspaceIds.includes(task.workspaceId),
  )
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
  channelId?: string
  initialWorkspaceId?: string
  initialTitle?: string
  initialDirectAgentId?: string
}

function workspaceNameFromDirectory(directory: string): string {
  return directory.split('/').filter(Boolean).at(-1) ?? '本地工作空间'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

interface TurnDetailsError {
  key: string
  source: 'bootstrap' | 'detail'
  message: string
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
