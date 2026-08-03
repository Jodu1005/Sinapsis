import { Bot, Plus } from 'lucide-react'
import { agentStatusLabel, distinctAgentsByIdentity, type AgentView } from '../domain/workspace-view'

export function AgentStatusList({ agents, onSelect, onCreate }: { agents: AgentView[]; onSelect(agent: AgentView): void; onCreate(): void }) {
  return <section className="agent-status-list" aria-label="Agent 状态">
    <div className="sidebar-section-label sidebar-section-heading"><span>运行中的 Agent</span><button className="icon-button" type="button" aria-label="添加 Agent" data-tooltip="添加 Agent" onClick={onCreate}><Plus size={15} /></button></div>
    {agents.length === 0 ? <p className="sidebar-empty">尚未添加 Agent</p> : distinctAgentsByIdentity(agents).map((agent) => <button className="agent-status" type="button" key={agent.id} aria-label={`查看 ${agent.identity} 配置`} onClick={() => onSelect(agent)}>
      <span className={`agent-avatar status-${agent.status}`}><Bot size={15} /></span>
      <span className="agent-copy"><strong>{agent.identity}</strong><small>@{agent.identity} · {agent.runtime}</small></span>
      <span className={`status-text status-${agent.status}`}>{agentStatusLabel(agent.status)}</span>
    </button>)}
  </section>
}
