import type { Task } from '../domain/control-room'

interface TaskCardProps {
  task: Task
  statusLabel: string
  selected: boolean
  onSelect: (taskId: string) => void
}

export function TaskCard({ task, statusLabel, selected, onSelect }: TaskCardProps) {
  return (
    <button
      type="button"
      className="task-card"
      data-status={task.status}
      aria-label={task.title}
      aria-pressed={selected}
      onClick={() => onSelect(task.id)}
    >
      <span className="task-card-title">{task.title}</span>
      <span className="task-card-status">{statusLabel}</span>
    </button>
  )
}
