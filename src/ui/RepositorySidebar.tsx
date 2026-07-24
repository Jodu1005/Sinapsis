import { FolderGit2, Hash, ListTodo, Menu, Plus, X } from 'lucide-react'
import type { AgentView, WorkspaceView } from '../domain/workspace-view'
import { AgentStatusList } from './AgentStatusList'

interface RepositorySidebarProps {
  workspace: WorkspaceView
  selectedChannelId: string | null
  onSelectChannel(channelId: string): void
  onSelectTasks(repositoryId: string): void
  onCreateTask(repositoryId: string): void
  onSelectAgent(agent: AgentView): void
  mobileOpen: boolean
  mobileHidden: boolean
  onClose(): void
}

export function RepositorySidebar({ workspace, selectedChannelId, onSelectChannel, onSelectTasks, onCreateTask, onSelectAgent, mobileOpen, mobileHidden, onClose }: RepositorySidebarProps) {
  return <nav className="repository-sidebar" aria-label="代码仓与频道" aria-hidden={mobileHidden || undefined} inert={mobileHidden} data-mobile-open={mobileOpen}>
    <div className="sidebar-topline">
      <div className="workspace-lockup"><span className="workspace-mark">S</span><strong>{workspace.name}</strong></div>
      <button className="icon-button sidebar-close" type="button" aria-label="关闭导航" data-tooltip="关闭导航" onClick={onClose}><X size={17} /></button>
    </div>
    <div className="sidebar-section-label">代码仓</div>
    <div className="repository-list">
      {workspace.repositories.map((repository) => <section className="repository-group" key={repository.id}>
        <div className="repository-name"><FolderGit2 size={16} /><span>{repository.name}</span><span className="branch-name">{repository.currentBranch}</span><button type="button" className="icon-button repository-task-create" aria-label={`新建 ${repository.name} 任务`} data-tooltip="新建任务" onClick={() => onCreateTask(repository.id)}><Plus size={15} /></button></div>
        <div className="channel-list">
          {repository.channels.map((channel) => <button key={channel.id} type="button" className="channel-button" aria-label={`# ${channel.name}`} aria-current={selectedChannelId === channel.id ? 'page' : undefined} onClick={() => onSelectChannel(channel.id)}>
            <Hash size={15} /> <span>{channel.name}</span>
          </button>)}
        </div>
        <button type="button" className="task-entry" onClick={() => onSelectTasks(repository.id)}><ListTodo size={15} /> <span>任务 {repository.tasks.length}</span></button>
      </section>)}
    </div>
    <AgentStatusList agents={workspace.agents} onSelect={onSelectAgent} />
  </nav>
}

export function NavigationToggle({ onClick }: { onClick(): void }) {
  return <button type="button" className="icon-button navigation-toggle" aria-label="打开导航" data-tooltip="打开导航" onClick={onClick}><Menu size={18} /></button>
}
