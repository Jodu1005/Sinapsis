import type { SessionEvent, TaskStatus } from '../domain/control-room'

interface TimelineProps {
  events: readonly SessionEvent[]
  taskStatus: TaskStatus
}

export function Timeline({ events, taskStatus }: TimelineProps) {
  return (
    <section className="timeline-section" aria-labelledby="timeline-title">
      <h3 id="timeline-title">活动时间轨</h3>
      {events.length === 0 ? (
        <p className="timeline-empty">暂无活动</p>
      ) : (
        <ol className="task-timeline" aria-label="任务活动">
          {events.map((event) => (
            <li
              key={event.id}
              data-kind={event.kind}
              data-tone={event.kind === 'decision' && taskStatus === 'rejected' ? 'rejection' : event.kind}
            >
              <time dateTime={event.at}>{event.at}</time>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
