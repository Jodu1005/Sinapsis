import type { Activity } from '../domain/control-room'

interface TimelineProps {
  activities: Activity[]
}

function getActivityKind(message: string) {
  if (message.startsWith('Agent ')) return 'agent'
  if (message.startsWith('请求人工决策')) return 'checkpoint'
  if (message.startsWith('人工反馈')) return 'feedback'
  if (message.startsWith('人工决定：已驳回')) return 'rejection'
  if (message.startsWith('人工决定')) return 'decision'
  return 'artifact'
}

export function Timeline({ activities }: TimelineProps) {
  return (
    <section className="timeline-section" aria-labelledby="timeline-title">
      <h3 id="timeline-title">活动时间轨</h3>
      <ol className="task-timeline" aria-label="任务活动">
        {activities.map((activity) => (
          <li key={activity.id} data-kind={getActivityKind(activity.message)}>
            <time dateTime={activity.at}>{activity.at}</time>
            <span>{activity.message}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
