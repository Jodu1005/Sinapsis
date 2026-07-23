import type { Task, TaskStatus } from '../domain/control-room'
import { TaskCard } from './TaskCard'

interface TaskBoardProps {
  tasks: Task[]
  selectedTaskId: string | undefined
  onSelectTask: (taskId: string) => void
}

const columns: Array<{ id: string; statuses: TaskStatus[]; title: string }> = [
  { id: 'todo', statuses: ['todo'], title: '待开始' },
  { id: 'running', statuses: ['running'], title: '执行中' },
  { id: 'needs_input', statuses: ['needs_input'], title: '等待输入' },
  { id: 'in_review', statuses: ['in_review'], title: '审查中' },
  { id: 'completed', statuses: ['accepted', 'rejected'], title: '已完成' },
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
        <section key={column.id} className="task-column" aria-labelledby={`task-column-${column.id}`}>
          <h2 id={`task-column-${column.id}`}>{column.title}</h2>
          <div>
            {tasks
              .filter((task) => column.statuses.includes(task.status))
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
