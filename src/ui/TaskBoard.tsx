import type { Task, TaskStatus } from '../domain/control-room'
import { TaskCard } from './TaskCard'

interface TaskBoardProps {
  tasks: Task[]
  selectedTaskId: string | undefined
  onSelectTask: (taskId: string) => void
}

const columns: Array<{ status: TaskStatus; title: string }> = [
  { status: 'todo', title: '待开始' },
  { status: 'running', title: '执行中' },
  { status: 'needs_input', title: '等待输入' },
  { status: 'in_review', title: '审查中' },
]

const statusLabels: Record<TaskStatus, string> = {
  todo: '待开始',
  running: '执行中',
  needs_input: '等待输入',
  in_review: '审查中',
  accepted: '已接受',
  rejected: '已驳回',
}

export function getTaskStatusLabel(status: TaskStatus) {
  return statusLabels[status]
}

export function TaskBoard({ tasks, selectedTaskId, onSelectTask }: TaskBoardProps) {
  return (
    <div className="task-board">
      {columns.map((column) => (
        <section key={column.status} className="task-column" aria-labelledby={`task-column-${column.status}`}>
          <h2 id={`task-column-${column.status}`}>{column.title}</h2>
          <div>
            {tasks
              .filter((task) => task.status === column.status)
              .map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  statusLabel={getTaskStatusLabel(task.status)}
                  selected={task.id === selectedTaskId}
                  onSelect={onSelectTask}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}
