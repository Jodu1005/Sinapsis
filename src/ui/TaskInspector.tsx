import type { Activity, Task } from '../domain/control-room'
import { ReviewActions } from './ReviewActions'
import { getTaskStatusLabel } from './TaskBoard'
import { Timeline } from './Timeline'

interface TaskInspectorProps {
  task: Task
  activities: Activity[]
  onRequestSummary: (taskId: string) => void
  onRequestDecision: (taskId: string) => void
  onSendFeedback: (taskId: string, feedback: string) => void
  onAccept: (taskId: string) => void
  onReject: (taskId: string) => void
}

export function TaskInspector({
  task,
  activities,
  onRequestSummary,
  onRequestDecision,
  onSendFeedback,
  onAccept,
  onReject,
}: TaskInspectorProps) {
  return (
    <div className="task-inspector">
      <header>
        <h2>{task.title}</h2>
        <p>{getTaskStatusLabel(task.status)}</p>
        <p>{task.summary}</p>
      </header>
      <section aria-label="改动文件">
        <h3>改动文件</h3>
        <ul>
          {task.changedFiles.map((file) => <li key={file}>{file}</li>)}
        </ul>
      </section>
      {task.diffSummary && <section aria-label="差异摘要"><h3>差异摘要</h3><p>{task.diffSummary}</p></section>}
      {task.testOutput && <section aria-label="测试输出"><h3>测试输出</h3><pre>{task.testOutput}</pre></section>}
      <Timeline activities={activities} />
      <ReviewActions
        task={task}
        onRequestSummary={onRequestSummary}
        onRequestDecision={onRequestDecision}
        onSendFeedback={onSendFeedback}
        onAccept={onAccept}
        onReject={onReject}
      />
    </div>
  )
}
