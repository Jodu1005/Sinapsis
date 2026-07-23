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
      aria-label={task.title}
      aria-pressed={selected}
      onClick={() => onSelect(task.id)}
    >
      <span>{task.title}</span>
      <span>{statusLabel}</span>
    </button>
  )
}
