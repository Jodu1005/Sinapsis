import { useMemo, useState } from 'react'
import { taskStatusLabel, type TaskView } from '../domain/workspace-view'

const filters = [
  ['waiting', '等待'], ['running', '执行中'], ['waiting_input', '等待输入'], ['in_review', '待人工验收'], ['ended', '已结束'],
] as const

export function TaskList({ tasks, selectedTaskId, onSelect }: { tasks: TaskView[]; selectedTaskId: string | null; onSelect(taskId: string): void }) {
  const [filter, setFilter] = useState<(typeof filters)[number][0]>('waiting')
  const visibleTasks = useMemo(() => tasks.filter((task) => matchesFilter(task, filter)), [tasks, filter])
  return <section className="task-list-panel"><div className="task-filter-row" role="tablist" aria-label="任务筛选">{filters.map(([value, label]) => <button key={value} role="tab" type="button" aria-selected={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {visibleTasks.length === 0 ? <p className="context-empty">此筛选下没有任务</p> : <div className="task-list">{visibleTasks.map((task) => <button type="button" key={task.id} className="task-row" aria-pressed={selectedTaskId === task.id} onClick={() => onSelect(task.id)}><span>{task.title}</span><small>{taskStatusLabel(task.status)}</small></button>)}</div>}
  </section>
}

function matchesFilter(task: TaskView, filter: (typeof filters)[number][0]): boolean {
  if (filter === 'waiting') return task.status === 'queued' || task.status === 'claimed'
  if (filter === 'running') return task.status === 'running'
  if (filter === 'waiting_input') return task.status === 'waiting_input'
  if (filter === 'in_review') return task.status === 'in_review'
  return ['accepted', 'returned', 'needs_human', 'merged', 'cancelled'].includes(task.status)
}
