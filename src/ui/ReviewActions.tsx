import { Check, CircleHelp, FileText, Send, X } from 'lucide-react'
import { useState } from 'react'
import type { Task } from '../domain/control-room'

interface ReviewActionsProps {
  task: Task
  onRequestSummary: (taskId: string) => void
  onRequestDecision: (taskId: string) => void
  onSendFeedback: (taskId: string, feedback: string) => void
  onAccept: (taskId: string) => void
  onReject: (taskId: string) => void
}

export function ReviewActions({
  task,
  onRequestSummary,
  onRequestDecision,
  onSendFeedback,
  onAccept,
  onReject,
}: ReviewActionsProps) {
  const [feedback, setFeedback] = useState('')
  const canRequestUpdate = task.status === 'running'
  const canSendFeedback = task.status === 'needs_input' || task.status === 'in_review'
  const canReview = task.status === 'in_review'

  function sendFeedback() {
    if (!canSendFeedback || !feedback.trim()) return

    onSendFeedback(task.id, feedback)
    setFeedback('')
  }

  return (
    <section className="review-actions" aria-label="控制操作">
      <div className="review-action-group review-action-group--context">
        <button type="button" onClick={() => onRequestSummary(task.id)} disabled={!canRequestUpdate}>
          <FileText aria-hidden="true" size={16} />
          请求总结
        </button>
        <button type="button" onClick={() => onRequestDecision(task.id)} disabled={!canRequestUpdate}>
          <CircleHelp aria-hidden="true" size={16} />
          需要决策
        </button>
      </div>
      <label className="feedback-field">
        <span>发送给 Agent 的反馈</span>
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} />
      </label>
      <button
        type="button"
        className="send-feedback"
        onClick={sendFeedback}
        disabled={!canSendFeedback || !feedback.trim()}
      >
        <Send aria-hidden="true" size={16} />
        发送反馈
      </button>
      <div className="review-action-group review-action-group--decision">
        <button
          type="button"
          className="accept-action"
          onClick={() => onAccept(task.id)}
          disabled={!canReview}
        >
          <Check aria-hidden="true" size={16} />
          接受改动
        </button>
        <button
          type="button"
          className="reject-action"
          onClick={() => onReject(task.id)}
          disabled={!canReview}
        >
          <X aria-hidden="true" size={16} />
          驳回改动
        </button>
      </div>
    </section>
  )
}
