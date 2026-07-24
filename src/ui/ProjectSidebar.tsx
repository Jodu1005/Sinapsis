import type { Activity, AgentSeat, ControlRoomSnapshot } from '../domain/control-room'

interface ProjectSidebarProps {
  projectName: ControlRoomSnapshot['projectName']
  branch: ControlRoomSnapshot['branch']
  agents: readonly AgentSeat[]
  activities: readonly Activity[]
}

const agentStateLabels: Record<AgentSeat['state'], string> = {
  active: '进行中',
  waiting: '等待中',
  reviewing: '审查中',
}

export function ProjectSidebar({
  projectName,
  branch,
  agents,
  activities,
}: ProjectSidebarProps) {
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
      <section className="recent-activity" aria-labelledby="recent-activity-title">
        <h3 id="recent-activity-title">近期活动</h3>
        {activities.length === 0 ? (
          <p>尚无活动</p>
        ) : (
          <ol aria-label="近期活动记录">
            {activities.map((activity) => (
              <li key={activity.id}>
                <time dateTime={activity.at}>{activity.at}</time>
                <span>{activity.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
