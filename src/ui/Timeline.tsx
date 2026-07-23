import type { Activity } from '../domain/control-room'

interface TimelineProps {
  activities: Activity[]
}

export function Timeline({ activities }: TimelineProps) {
  return (
    <ol className="task-timeline" aria-label="任务活动">
      {activities.map((activity) => (
        <li key={activity.id}>
          <time dateTime={activity.at}>{activity.at}</time>
          <span>{activity.message}</span>
        </li>
      ))}
    </ol>
  )
}
