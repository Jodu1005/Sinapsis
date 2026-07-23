import type { Task } from '../domain/control-room'
import { ReviewActions } from './ReviewActions'
import { getTaskStatusLabel } from './TaskBoard'
import { Timeline } from './Timeline'

interface TaskInspectorProps {
  task: Task
  onRequestSummary: (taskId: string) => void
  onRequestDecision: (taskId: string) => void
  onSendFeedback: (taskId: string, feedback: string) => void
  onAccept: (taskId: string) => void
  onReject: (taskId: string) => void
}

export function TaskInspector({
  task,
  onRequestSummary,
  onRequestDecision,
  onSendFeedback,
  onAccept,
  onReject,
}: TaskInspectorProps) {
  return (
    <div className="task-inspector" data-status={task.status}>
      <header className="inspector-heading">
        <h2>{task.title}</h2>
        <p className="inspector-status">{getTaskStatusLabel(task.status)}</p>
        <p className="inspector-summary">{task.summary}</p>
      </header>
      <section className="evidence-section changed-files" aria-label="改动文件">
        <h3>改动文件</h3>
        <ul>
          {task.changedFiles.map((file) => <li key={file}>{file}</li>)}
        </ul>
      </section>
      {task.diffSummary && (
        <section className="evidence-section diff-summary" aria-label="差异摘要">
          <h3>差异摘要</h3>
          <p>{task.diffSummary}</p>
        </section>
      )}
      {task.testOutput && (
        <section className="evidence-section test-output" aria-label="测试输出">
          <h3>测试输出</h3>
          <pre>{task.testOutput}</pre>
        </section>
      )}
      <Timeline events={task.events} taskStatus={task.status} />
      <ReviewActions
        key={task.id}
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
