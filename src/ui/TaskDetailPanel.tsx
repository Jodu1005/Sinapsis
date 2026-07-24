import { SendHorizontal } from 'lucide-react'
import { FormEvent, useEffect, useState } from 'react'
import type { TaskDetailView } from '../domain/workspace-view'
import { taskStatusLabel } from '../domain/workspace-view'
import { RuntimeEvidence } from './RuntimeEvidence'

export function TaskDetailPanel({ details, onQueueInput, onReview, onReadArtifact }: { details: TaskDetailView; onQueueInput(body: string): Promise<void>; onReview(action: 'accept' | 'return'): Promise<void>; onReadArtifact(artifactId: string): Promise<string> }) {
  const [input, setInput] = useState('')
  const [queued, setQueued] = useState(false)
  const [acceptedTaskId, setAcceptedTaskId] = useState<string | null>(details.task.status === 'accepted' ? details.task.id : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setQueued(false) }, [details.task.id])
  const submitInput = async (event: FormEvent) => {
    event.preventDefault()
    if (!input.trim()) return
    setBusy(true)
    setError(null)
    try { await onQueueInput(input.trim()); setInput(''); setQueued(true) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法发送任务输入。') } finally { setBusy(false) }
  }
  const review = async (action: 'accept' | 'return') => {
    setBusy(true)
    setError(null)
    try { await onReview(action); if (action === 'accept') setAcceptedTaskId(details.task.id) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法提交审查决定。') } finally { setBusy(false) }
  }
  const acceptsInput = ['claimed', 'running', 'waiting_input'].includes(details.task.status)
  const accepted = details.task.status === 'accepted' || acceptedTaskId === details.task.id
  return <section className="task-detail-panel" aria-label="任务详情"><div className="detail-section"><h3>概览</h3><strong>{details.task.title}</strong><p>{details.task.description}</p><dl className="task-summary"><div><dt>状态</dt><dd>{accepted ? '已验收' : taskStatusLabel(details.task.status)}</dd></div><div><dt>验收标准</dt><dd>{details.task.acceptanceCriteria}</dd></div><div><dt>标签</dt><dd>{details.task.labels.join(', ') || '未设置'}</dd></div></dl></div>
    <section className="detail-section"><h3>输入队列</h3>{details.inputs.length ? <ul className="input-queue">{details.inputs.map((item) => <li key={item.id}>{item.body}<small>{item.consumedAt ? '已送达' : '等待安全步骤'}</small></li>)}</ul> : <p className="context-empty">没有待发送输入</p>}{acceptsInput && <form className="task-input-form" onSubmit={submitInput}><label className="sr-only" htmlFor="task-input">发送任务输入</label><textarea id="task-input" aria-label="发送任务输入" value={input} onChange={(event) => setInput(event.target.value)} placeholder="给正在运行的 Agent 补充信息" rows={2} /><button type="submit" aria-label="发送任务输入" disabled={busy || !input.trim()}><SendHorizontal size={16} /></button></form>}{queued && <p className="assignment-note">已排队，当前安全步骤结束后送达。</p>}</section>
    <RuntimeEvidence artifacts={details.artifacts} onReadArtifact={onReadArtifact} />
    <section className="detail-section review-section"><h3>审查</h3>{accepted ? <p className="review-success">验收已通过，尚未合并</p> : <><p className="detail-hint">验收与合并分离；内置 API 不会自动 push 或 merge。</p><p className="detail-hint">此版本没有 OS 级沙箱。运行未经信任的本地 CLI 前，请先确认信任它。工作树隔离是约定而非权限边界。</p><div><button type="button" className="secondary-action" disabled={busy || details.task.status !== 'in_review'} onClick={() => void review('return')}>退回修改</button><button type="button" className="primary-action" disabled={busy || details.task.status !== 'in_review'} onClick={() => void review('accept')}>接受验收</button></div></>}{error && <p className="form-error" role="alert">{error}</p>}</section>
  </section>
}
