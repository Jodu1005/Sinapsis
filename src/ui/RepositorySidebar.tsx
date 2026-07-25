import { FolderKanban, Hash, ListTodo, Menu, Plus, X } from 'lucide-react'
import type { AgentView, WorkspaceView } from '../domain/workspace-view'
import { AgentStatusList } from './AgentStatusList'

interface RepositorySidebarProps {
  workspace: WorkspaceView
  workspaces: WorkspaceView[]
  selectedChannelId: string | null
  selectedTaskId: string | null
  onSelectWorkspace(workspaceId: string): void
  onSelectChannel(channelId: string): void
  onSelectTask(repositoryId: string, taskId: string): void
  onCreateTask(repositoryId: string): void
  onCreateWorkspace(): void
  onSelectAgent(agent: AgentView): void
  onCreateAgent(): void
  mobileOpen: boolean
  mobileHidden: boolean
  onClose(): void
}

export function RepositorySidebar({ workspace, workspaces, selectedChannelId, selectedTaskId, onSelectWorkspace, onSelectChannel, onSelectTask, onCreateTask, onCreateWorkspace, onSelectAgent, onCreateAgent, mobileOpen, mobileHidden, onClose }: RepositorySidebarProps) {
  const workspaceTasks = workspace.repositories.flatMap((repository) => repository.tasks.map((task) => ({ repository, task })))
  const channels = workspace.repositories.flatMap((repository) => repository.channels)
  const taskRepository = workspace.repositories[0]
  return <nav className="repository-sidebar" aria-label="工作空间" aria-hidden={mobileHidden || undefined} inert={mobileHidden} data-mobile-open={mobileOpen}>
    <div className="sidebar-topline">
      <span className="workspace-label">工作空间</span>
      <div><button className="icon-button workspace-create" type="button" aria-label="添加工作空间" data-tooltip="添加工作空间" onClick={onCreateWorkspace}><Plus size={17} /></button><button className="icon-button sidebar-close" type="button" aria-label="关闭导航" data-tooltip="关闭导航" onClick={onClose}><X size={17} /></button></div>
    </div>
    <div className="workspace-list">{workspaces.map((candidate) => <button type="button" key={candidate.id} className="workspace-selector" aria-current={candidate.id === workspace.id ? 'page' : undefined} onClick={() => onSelectWorkspace(candidate.id)}><span className="workspace-mark">{candidate.name.slice(0, 1)}</span><span>{candidate.name}</span></button>)}</div>
    <div className="sidebar-section-label">任务</div>
    <div className="workspace-task-list">
      <div className="workspace-task-heading"><FolderKanban size={16} /><span>{workspace.name}</span>{taskRepository && <button type="button" className="icon-button repository-task-create" aria-label={`新建 ${workspace.name} 任务`} data-tooltip="新建任务" onClick={() => onCreateTask(taskRepository.id)}><Plus size={15} /></button>}</div>
      {workspaceTasks.length === 0 ? <p className="sidebar-empty">还没有任务</p> : workspaceTasks.map(({ repository, task }) => <button type="button" className="task-entry" key={task.id} aria-pressed={selectedTaskId === task.id} onClick={() => onSelectTask(repository.id, task.id)}><ListTodo size={15} /><span>{task.title}</span></button>)}
    </div>
    <div className="sidebar-section-label">频道</div>
    <div className="channel-list">{channels.map((channel) => <button key={channel.id} type="button" className="channel-button" aria-label={`# ${channel.name}`} aria-current={selectedChannelId === channel.id ? 'page' : undefined} onClick={() => onSelectChannel(channel.id)}><Hash size={15} /><span>{channel.name}</span></button>)}</div>
    <AgentStatusList agents={workspace.agents} onSelect={onSelectAgent} onCreate={onCreateAgent} />
  </nav>
}

export function NavigationToggle({ onClick }: { onClick(): void }) {
  return <button type="button" className="icon-button navigation-toggle" aria-label="打开导航" data-tooltip="打开导航" onClick={onClick}><Menu size={18} /></button>
}
