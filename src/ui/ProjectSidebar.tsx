import type { AgentSeat, ControlRoomSnapshot } from '../domain/control-room'

interface ProjectSidebarProps {
  projectName: ControlRoomSnapshot['projectName']
  branch: ControlRoomSnapshot['branch']
  agents: AgentSeat[]
}

const agentStateLabels: Record<AgentSeat['state'], string> = {
  active: '进行中',
  waiting: '等待中',
  reviewing: '审查中',
}

export function ProjectSidebar({ projectName, branch, agents }: ProjectSidebarProps) {
  return (
    <div className="project-sidebar">
      <header className="project-heading">
        <h2>{projectName}</h2>
        <p className="project-branch">{branch}</p>
      </header>
      <ul className="agent-list" aria-label="Agent 席位">
        {agents.map((agent) => (
          <li key={agent.id} className="agent-seat" data-state={agent.state}>
            <div className="agent-identity">
              <strong>{agent.name}</strong>
              <span className="agent-role">{agent.role}</span>
            </div>
            <span className="agent-runtime">{agent.runtime}</span>
            <span className="agent-state">{agentStateLabels[agent.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
