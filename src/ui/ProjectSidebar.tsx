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
      <header>
        <h2>{projectName}</h2>
        <p>{branch}</p>
      </header>
      <ul aria-label="Agent 席位">
        {agents.map((agent) => (
          <li key={agent.id} className="agent-seat">
            <strong>{agent.name}</strong>
            <span>{agent.role}</span>
            <span>{agent.runtime}</span>
            <span>{agentStateLabels[agent.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
