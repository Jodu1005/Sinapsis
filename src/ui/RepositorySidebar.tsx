import { Archive, ArchiveRestore, ChevronDown, ChevronRight, FolderKanban, Hash, ListTodo, Menu, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { AgentView, ChannelView, TaskView, WorkspaceView } from '../domain/workspace-view'
import { AgentStatusList } from './AgentStatusList'

interface RepositorySidebarProps {
  workspace: WorkspaceView
  agents: AgentView[]
  channels: ChannelView[]
  tasks: TaskView[]
  selectedChannelId: string | null
  selectedTaskId: string | null
  onSelectChannel(channelId: string): void
  onSelectTask(repositoryId: string, taskId: string): void
  onCreateTask(repositoryId: string): void
  onCreateChannel(repositoryId: string): void
  onArchiveChannel(channelId: string): void
  onRestoreChannel(channelId: string): void
  channelReadOnly: boolean
  onCreateWorkspace(): void
  onSelectAgent(agent: AgentView): void
  onCreateAgent(): void
  mobileOpen: boolean
  mobileHidden: boolean
  onClose(): void
}

export function RepositorySidebar({ workspace, agents, channels, tasks, selectedChannelId, selectedTaskId, onSelectChannel, onSelectTask, onCreateTask, onCreateChannel, onArchiveChannel, onRestoreChannel, channelReadOnly, onCreateWorkspace, onSelectAgent, onCreateAgent, mobileOpen, mobileHidden, onClose }: RepositorySidebarProps) {
  const [archivedOpen, setArchivedOpen] = useState(false)
  const workspaceTasks = tasks.flatMap((task) => {
    if (task.workspaceId !== workspace.id || task.channelId !== selectedChannelId) return []
    const repository = workspace.repositories.find((candidate) => candidate.id === task.repositoryId)
    return repository ? [{ repository, task }] : []
  })
  const activeChannels = channels.filter((channel) => !channel.archivedAt)
  const archivedChannels = channels.filter((channel) => channel.archivedAt)
  const taskRepository = workspace.repositories[0]
  return <nav className="repository-sidebar" aria-label="工作空间" aria-hidden={mobileHidden || undefined} inert={mobileHidden} data-mobile-open={mobileOpen}>
    <div className="sidebar-channel-heading"><span>频道</span>{taskRepository && <button type="button" className="icon-button channel-create" aria-label="添加频道" data-tooltip="添加频道" onClick={() => onCreateChannel(taskRepository.id)}><Plus size={15} /></button>}</div>
    <div className="channel-list">{activeChannels.map((channel) => <ChannelEntry key={channel.id} channel={channel} selected={selectedChannelId === channel.id} onSelect={onSelectChannel} onToggleArchive={onArchiveChannel} />)}</div>
    {archivedChannels.length > 0 && <section className="archived-channel-folder" aria-label="已归档频道"><button type="button" className="archived-folder-toggle" aria-expanded={archivedOpen} aria-label={`已归档频道（${archivedChannels.length}）`} onClick={() => setArchivedOpen((open) => !open)}>{archivedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span>已归档频道</span><small>{archivedChannels.length}</small></button>{archivedOpen && <div className="channel-list archived-channel-list">{archivedChannels.map((channel) => <ChannelEntry key={channel.id} channel={channel} selected={selectedChannelId === channel.id} onSelect={onSelectChannel} onToggleArchive={onRestoreChannel} />)}</div>}</section>}
    <div className="sidebar-topline">
      <span className="workspace-label">工作空间</span>
      <div><button className="icon-button workspace-create" type="button" aria-label="添加工作空间" data-tooltip="添加工作空间" onClick={onCreateWorkspace}><Plus size={17} /></button><button className="icon-button sidebar-close" type="button" aria-label="关闭导航" data-tooltip="关闭导航" onClick={onClose}><X size={17} /></button></div>
    </div>
    <div className="workspace-list"><div className="workspace-context" role="group" aria-label={`当前频道工作空间：${workspace.name}`}><span className="workspace-mark">{workspace.name.slice(0, 1)}</span><span>{workspace.name}</span></div></div>
    <div className="sidebar-section-label">任务</div>
    <div className="workspace-task-list">
      <div className="workspace-task-heading"><FolderKanban size={16} /><span>{workspace.name}</span>{taskRepository && !channelReadOnly && <button type="button" className="icon-button repository-task-create" aria-label={`新建 ${workspace.name} 任务`} data-tooltip="新建任务" onClick={() => onCreateTask(taskRepository.id)}><Plus size={15} /></button>}</div>
      {workspaceTasks.length === 0 ? <p className="sidebar-empty">还没有任务</p> : workspaceTasks.map(({ repository, task }) => <button type="button" className="task-entry" key={task.id} aria-pressed={selectedTaskId === task.id} onClick={() => onSelectTask(repository.id, task.id)}><ListTodo size={15} /><span>{task.title}</span></button>)}
    </div>
    <AgentStatusList agents={agents} onSelect={onSelectAgent} onCreate={onCreateAgent} />
  </nav>
}

function ChannelEntry({ channel, selected, onSelect, onToggleArchive }: { channel: { id: string; name: string; archivedAt?: string | null }; selected: boolean; onSelect(channelId: string): void; onToggleArchive(channelId: string): void }) {
  const archived = Boolean(channel.archivedAt)
  return <div className="channel-entry"><button type="button" className="channel-button" aria-label={`# ${channel.name}`} aria-current={selected ? 'page' : undefined} onClick={() => onSelect(channel.id)}><Hash size={15} /><span>{channel.name}</span></button><button type="button" className="channel-archive-button" aria-label={`${archived ? '恢复' : '归档'} # ${channel.name}`} data-tooltip={archived ? '恢复频道' : '归档频道'} onClick={() => onToggleArchive(channel.id)}>{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button></div>
}

export function NavigationToggle({ onClick }: { onClick(): void }) {
  return <button type="button" className="icon-button navigation-toggle" aria-label="打开导航" data-tooltip="打开导航" onClick={onClick}><Menu size={18} /></button>
}
