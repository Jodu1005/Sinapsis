import type { Task } from '../domain/control-room'

interface TaskCardProps {
  task: Task
  ownerName: string
  statusLabel: string
  selected: boolean
  onSelect: (taskId: string) => void
}

function formatUpdatedAt(updatedAt: string) {
  const date = new Date(updatedAt)

  if (Number.isNaN(date.getTime())) return updatedAt

  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

export function TaskCard({
  task,
  ownerName,
  statusLabel,
  selected,
  onSelect,
}: TaskCardProps) {
  const statusDescriptionId = `task-${task.id}-status`

  return (
    <button
      type="button"
      className="task-card"
      data-status={task.status}
      aria-label={task.title}
      aria-describedby={statusDescriptionId}
      aria-pressed={selected}
      onClick={() => onSelect(task.id)}
    >
      <span className="task-card-title">{task.title}</span>
      <span className="task-card-summary">{task.summary}</span>
      <span className="task-card-metadata">
        <span>负责人 {ownerName}</span>
        <time dateTime={task.updatedAt}>更新于 {formatUpdatedAt(task.updatedAt)}</time>
      </span>
      <span className="task-card-status" id={statusDescriptionId}>{statusLabel}</span>
    </button>
  )
}
