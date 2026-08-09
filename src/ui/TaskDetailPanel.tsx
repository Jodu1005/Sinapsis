import { SendHorizontal } from 'lucide-react'
import { FormEvent, useEffect, useState } from 'react'
import type { TaskDetailView } from '../domain/workspace-view'
import { taskStatusLabel } from '../domain/workspace-view'
import { RuntimeEvidence } from './RuntimeEvidence'

export function TaskDetailPanel({ details, expanded = false, onQueueInput, onReview, onRequeue, onReadArtifact }: { details: TaskDetailView; expanded?: boolean; onQueueInput(body: string): Promise<void>; onReview(action: 'accept' | 'return', message: string): Promise<void>; onRequeue?(): Promise<void>; onReadArtifact(artifactId: string): Promise<string> }) {
  const [input, setInput] = useState('')
  const [reviewMessage, setReviewMessage] = useState('')
  const [queued, setQueued] = useState(false)
  const [acceptedTaskId, setAcceptedTaskId] = useState<string | null>(details.task.status === 'accepted' ? details.task.id : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setQueued(false); setReviewMessage('') }, [details.task.id])
  const submitInput = async (event: FormEvent) => {
    event.preventDefault()
    if (!input.trim()) return
    setBusy(true)
    setError(null)
    try { await onQueueInput(input.trim()); setInput(''); setQueued(true) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法发送任务输入。') } finally { setBusy(false) }
  }
  const review = async (action: 'accept' | 'return') => {
    const message = action === 'accept' ? reviewMessage.trim() || '验收已通过。' : reviewMessage.trim()
    if (action === 'return' && !message) {
      setError('退回任务前需要填写修改意见。')
      return
    }
    setBusy(true)
    setError(null)
    try { await onReview(action, message); if (action === 'accept') setAcceptedTaskId(details.task.id); else setReviewMessage('') } catch (cause) { setError(cause instanceof Error ? cause.message : '无法提交审查决定。') } finally { setBusy(false) }
  }
  const requeue = async () => {
    if (!onRequeue) return
    setBusy(true)
    setError(null)
    try { await onRequeue() } catch (cause) { setError(cause instanceof Error ? cause.message : '无法重新执行任务。') } finally { setBusy(false) }
  }
  const acceptsInput = ['claimed', 'running', 'waiting_input'].includes(details.task.status)
  const accepted = details.task.status === 'accepted' || acceptedTaskId === details.task.id
  return <section className="task-detail-panel" aria-label="任务详情"><div className="detail-section"><h3>概览</h3><strong>{details.task.title}</strong><p>{details.task.description}</p><dl className="task-summary"><div><dt>状态</dt><dd>{accepted ? '已验收' : taskStatusLabel(details.task.status)}</dd></div><div><dt>验收标准</dt><dd>{details.task.acceptanceCriteria}</dd></div><div><dt>标签</dt><dd>{details.task.labels.join(', ') || '未设置'}</dd></div></dl></div>
    {expanded && <section className="detail-section execution-details"><h3>执行状态</h3><dl className="task-summary"><div><dt>执行会话</dt><dd>{details.sessions.length ? details.sessions.map((session) => `${session.status} · ${session.runtimeSessionId ?? session.id}`).join('\n') : '无'}</dd></div><div><dt>任务租约</dt><dd>{details.leases.length ? details.leases.map((lease) => `${lease.agentId} · 到期 ${lease.expiresAt}`).join('\n') : '无'}</dd></div><div><dt>人工决定</dt><dd>{details.decisions.length ? details.decisions.map((decision) => `${decision.decision} · ${decision.reason}`).join('\n') : '无'}</dd></div></dl></section>}
    <section className="detail-section"><h3>输入队列</h3>{details.inputs.length ? <ul className="input-queue">{details.inputs.map((item) => <li key={item.id}>{item.body}<small>{item.consumedAt ? '已送达' : '等待安全步骤'}</small></li>)}</ul> : <p className="context-empty">没有待发送输入</p>}{acceptsInput && <form className="task-input-form" onSubmit={submitInput}><label className="sr-only" htmlFor="task-input">发送任务输入</label><textarea id="task-input" aria-label="发送任务输入" value={input} onChange={(event) => setInput(event.target.value)} placeholder="给正在运行的 Agent 补充信息" rows={2} /><button type="submit" aria-label="发送任务输入" disabled={busy || !input.trim()}><SendHorizontal size={16} /></button></form>}{queued && <p className="assignment-note">已排队，当前安全步骤结束后送达。</p>}</section>
    {details.task.status === 'needs_human' && <section className="detail-section"><h3>恢复执行</h3><p className="detail-hint">任务未能正常结束。重新执行会保留任务工作树里的现有改动。</p><button type="button" className="primary-action" disabled={busy || !onRequeue} onClick={() => void requeue()}>重新执行</button>{error && <p className="form-error" role="alert">{error}</p>}</section>}
    <RuntimeEvidence artifacts={details.artifacts} events={details.events} expanded={expanded} onReadArtifact={onReadArtifact} />
    {(details.task.status === 'in_review' || accepted) && <section className="detail-section review-section"><h3>审查</h3>{accepted ? <p className="review-success">验收已通过</p> : <><p className="detail-hint">审核只看任务结果，无需提交或合并。</p><p className="detail-hint">此版本没有 OS 级沙箱。运行未经信任的本地 CLI 前，请先确认信任它。运行目录隔离是约定而非权限边界。</p><label className="review-message-field">审核意见<textarea aria-label="审核意见" value={reviewMessage} onChange={(event) => setReviewMessage(event.target.value)} placeholder="通过可留空；退回时请写明修改意见" rows={3} /></label><div><button type="button" className="secondary-action" disabled={busy} onClick={() => void review('return')}>退回修改</button><button type="button" className="primary-action" disabled={busy} onClick={() => void review('accept')}>接受验收</button></div></>}{details.task.status !== 'needs_human' && error && <p className="form-error" role="alert">{error}</p>}</section>}
  </section>
}
