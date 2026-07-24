import { PanelRightClose, PanelRightOpen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkspaceApi } from '../api/client'
import { ApiClient } from '../api/client'
import { useWorkspaceEvents } from '../api/use-workspace-events'
import { channelMessages, taskStatusLabel, type RepositoryView, type TaskView, type WorkspaceSnapshot, type WorkspaceView } from '../domain/workspace-view'
import { ChannelTimeline } from './ChannelTimeline'
import { MessageComposer } from './MessageComposer'
import { NavigationToggle, RepositorySidebar } from './RepositorySidebar'
import { WorkspaceSetup } from './WorkspaceSetup'

export function WorkspaceShell({ api: providedApi }: { api?: WorkspaceApi }) {
  const [defaultApi] = useState(() => new ApiClient())
  const api = providedApi ?? defaultApi
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedTaskRepositoryId, setSelectedTaskRepositoryId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const narrowNavigation = useMediaQuery('(max-width: 700px)')
  const narrowContext = useMediaQuery('(max-width: 980px)')
  const refresh = useCallback(async () => {
    try { setSnapshot(await api.getBootstrap()); setError(null) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取工作空间。') }
  }, [api])
  const reconnecting = useWorkspaceEvents(refresh)
  useEffect(() => { void refresh() }, [refresh])

  const workspace = snapshot?.workspaces[0]
  const selection = useMemo(() => findSelection(workspace, selectedChannelId), [workspace, selectedChannelId])
  useEffect(() => { if (selection.channel && selectedChannelId !== selection.channel.id) setSelectedChannelId(selection.channel.id) }, [selection.channel, selectedChannelId])
  const taskRepository = useMemo(() => findRepository(workspace, selectedTaskRepositoryId), [workspace, selectedTaskRepositoryId])
  const taskScope = taskRepository ?? selection.repository
  const selectedTask = useMemo(() => findTask(workspace, selectedTaskId) ?? (!taskRepository ? selection.repository?.tasks.find((task) => task.channelId === selection.channel?.id) : null), [workspace, selectedTaskId, taskRepository, selection])

  if (!snapshot) return <main className="workspace-loading"><p>{error ?? '正在连接本机工作空间...'}</p>{error && <button type="button" onClick={() => void refresh()}>重试</button>}</main>
  if (!workspace) return <WorkspaceSetup api={api} onComplete={refresh} />
  if (!selection.channel || !selection.repository) return <main className="workspace-loading"><p>这个工作空间还没有频道。</p></main>

  const sendMessage = async (body: string) => { await api.postMessage(selection.channel!.id, { body }); await refresh() }
  const selectChannel = (channelId: string) => { setSelectedChannelId(channelId); setSelectedTaskId(null); setSelectedTaskRepositoryId(null); setNavOpen(false) }
  const selectRepositoryTasks = (repositoryId: string) => { setSelectedTaskId(null); setSelectedTaskRepositoryId(repositoryId); setContextOpen(true); setNavOpen(false) }
  return <div className="workspace-shell">
    <RepositorySidebar workspace={workspace} selectedChannelId={selection.channel.id} onSelectChannel={selectChannel} onSelectTasks={selectRepositoryTasks} mobileOpen={navOpen} mobileHidden={narrowNavigation && !navOpen} onClose={() => setNavOpen(false)} />
    <main className="conversation-panel">
      <header className="channel-header"><NavigationToggle onClick={() => setNavOpen(true)} /><div className="channel-heading"><h1># {selection.channel.name}</h1><p>{selection.repository.name} · {selection.repository.currentBranch}</p></div><div className="header-actions"><span className="connection-state" data-reconnecting={reconnecting}>{reconnecting ? '正在重新连接' : '已连接'}</span><button type="button" className="icon-button" aria-label="打开上下文" data-tooltip="打开上下文" onClick={() => setContextOpen(true)}><PanelRightOpen size={18} /></button></div></header>
      <ChannelTimeline messages={channelMessages(workspace, selection.channel.id)} />
      <MessageComposer channelName={selection.channel.name} onSend={sendMessage} />
    </main>
    <aside className="context-panel" aria-label="任务与上下文" aria-hidden={narrowContext && !contextOpen || undefined} inert={narrowContext && !contextOpen} data-mobile-open={contextOpen}>
      <header className="context-header"><strong>上下文</strong><button type="button" className="icon-button context-close" aria-label="关闭上下文" data-tooltip="关闭上下文" onClick={() => setContextOpen(false)}><X size={17} /></button></header>
      <section className="context-section"><h2>{taskRepository ? `${taskRepository.name} 任务` : '本频道任务'}</h2>{taskScope.tasks.filter((task) => taskRepository || task.channelId === selection.channel!.id).length === 0 ? <p className="context-empty">没有关联任务</p> : <div className="task-list">{taskScope.tasks.filter((task) => taskRepository || task.channelId === selection.channel!.id).map((task) => <button type="button" key={task.id} className="task-row" aria-pressed={selectedTask?.id === task.id} onClick={() => setSelectedTaskId(task.id)}><span>{task.title}</span><small>{taskStatusLabel(task.status)}</small></button>)}</div>}</section>
      {selectedTask && <TaskContext task={selectedTask} />}
      <section className="context-section"><h2>频道操作</h2><button type="button" className="context-action" onClick={() => setContextOpen(false)}><PanelRightClose size={16} /> 收起上下文</button></section>
    </aside>
  </div>
}

function TaskContext({ task }: { task: TaskView }) {
  return <section className="context-section selected-task"><h2>任务详情</h2><strong>{task.title}</strong><p>{task.description}</p><dl><div><dt>状态</dt><dd>{taskStatusLabel(task.status)}</dd></div><div><dt>验收</dt><dd>{task.acceptanceCriteria}</dd></div>{task.branchName && <div><dt>分支</dt><dd><code>{task.branchName}</code></dd></div>}</dl></section>
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
