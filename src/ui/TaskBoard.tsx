import { Bot, CheckCircle2, ClipboardList, Clock3, ListTodo, LoaderCircle, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { taskStatusLabel, type AgentView, type TaskBoardLane, type TaskView } from '../domain/workspace-view'

const lanes: Array<{ id: TaskBoardLane; title: string; icon: typeof ClipboardList }> = [
  { id: 'backlog', title: '积压任务', icon: ClipboardList },
  { id: 'todo', title: '待办任务', icon: ListTodo },
  { id: 'doing', title: '处理中任务', icon: LoaderCircle },
  { id: 'review', title: '审核任务', icon: RotateCcw },
  { id: 'done', title: '已完成任务', icon: CheckCircle2 },
]

export function TaskBoard({ tasks, agents, selectedTaskId, readOnly, onSelect, onMove }: {
  tasks: TaskView[]
  agents: AgentView[]
  selectedTaskId: string | null
  readOnly?: boolean
  onSelect(taskId: string): void
  onMove(taskId: string, lane: TaskBoardLane, message?: string): Promise<void>
}) {
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null)
  const [activeLaneId, setActiveLaneId] = useState<TaskBoardLane | null>(null)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const tasksByLane = useMemo(() => {
    const grouped = new Map<TaskBoardLane, TaskView[]>(lanes.map((lane) => [lane.id, []]))
    for (const task of [...tasks].sort(compareTasks)) grouped.get(taskLane(task))!.push(task)
    return grouped
  }, [tasks])

  const dropOnLane = async (lane: TaskBoardLane) => {
    const task = tasks.find((candidate) => candidate.id === draggingTaskId)
    setDraggingTaskId(null)
    setActiveLaneId(null)
    if (!task || readOnly || busyTaskId) return
    if (taskLane(task) === lane) return
    if (!canMoveTaskToLane(task, lane)) {
      setError('只能将积压任务移到待办，或将审核任务移到待办/已完成。')
      return
    }
    let message: string | undefined
    if (task.status === 'in_review' && lane === 'todo') {
      message = window.prompt('请输入退回修改意见')?.trim()
      if (!message) {
        setError('审核任务退回待办前需要填写修改意见。')
        return
      }
    }
    setBusyTaskId(task.id)
    setError(null)
    try {
      await onMove(task.id, lane, message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法移动任务。')
    } finally {
      setBusyTaskId(null)
    }
  }

  return <section className="task-board" aria-label="任务看板">
    {error && <p className="task-board-error" role="alert">{error}</p>}
    <div className="task-board-lanes">
      {lanes.map((lane) => {
        const laneTasks = tasksByLane.get(lane.id) ?? []
        const Icon = lane.icon
        return <section
          key={lane.id}
          className="task-lane"
          data-lane={lane.id}
          data-drop-target={activeLaneId === lane.id || undefined}
          onDragOver={(event) => {
            if (readOnly) return
            event.preventDefault()
            setActiveLaneId(lane.id)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActiveLaneId(null)
          }}
          onDrop={(event) => { event.preventDefault(); void dropOnLane(lane.id) }}
          aria-label={lane.title}
        >
          <header><span><Icon size={15} />{lane.title}</span><small>{laneTasks.length}</small></header>
          <div className="task-lane-stack">
            {laneTasks.length === 0
              ? <p className="task-lane-empty">暂无任务</p>
              : laneTasks.map((task) => {
                  const agent = agentsById.get(task.lastAgentId ?? task.directAgentId ?? '')
                  return <button
                  key={task.id}
                  type="button"
                  className="task-card"
                  aria-pressed={selectedTaskId === task.id}
                  draggable={!readOnly && canDragTask(task)}
                  data-dragging={draggingTaskId === task.id || undefined}
                  disabled={busyTaskId === task.id}
                  onClick={() => onSelect(task.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', task.id)
                    setDraggingTaskId(task.id)
                  }}
                  onDragEnd={() => { setDraggingTaskId(null); setActiveLaneId(null) }}
                  onPointerDown={(event) => {
                    if (event.currentTarget.disabled) return
                    event.currentTarget.dataset.pressed = 'true'
                  }}
                  onPointerUp={(event) => { delete event.currentTarget.dataset.pressed }}
                  onPointerCancel={(event) => { delete event.currentTarget.dataset.pressed }}
                  onPointerLeave={(event) => { delete event.currentTarget.dataset.pressed }}
                >
                  <span>{task.title}</span>
                  <small>{taskStatusLabel(task.status)}</small>
                  {agent && <small className="task-card-agent"><Bot size={12} />@{agent.identity}</small>}
                  {task.labels.length > 0 && <em>{task.labels.slice(0, 3).join(' / ')}</em>}
                  <time className="task-card-time" dateTime={task.createdAt}><Clock3 size={11} />创建于 {formatTaskTime(task.createdAt)}</time>
                </button>
                })}
          </div>
        </section>
      })}
    </div>
  </section>
}

export function taskLane(task: TaskView): TaskBoardLane {
  if (task.status === 'backlog' || task.status === 'needs_human') return 'backlog'
  if (task.status === 'queued' || task.status === 'returned') return 'todo'
  if (task.status === 'claimed' || task.status === 'running' || task.status === 'waiting_input') return 'doing'
  if (task.status === 'in_review') return 'review'
  return 'done'
}

function canDragTask(task: TaskView): boolean {
  return task.status === 'backlog' || task.status === 'needs_human' || task.status === 'in_review'
}

function canMoveTaskToLane(task: TaskView, lane: TaskBoardLane): boolean {
  if ((task.status === 'backlog' || task.status === 'needs_human') && lane === 'todo') return true
  if (task.status === 'in_review' && (lane === 'todo' || lane === 'done')) return true
  return false
}

function compareTasks(left: TaskView, right: TaskView): number {
  return left.queuedAt.localeCompare(right.queuedAt)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
}

function formatTaskTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
