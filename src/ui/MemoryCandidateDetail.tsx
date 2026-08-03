import { Check, ExternalLink, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AcceptMemoryCandidateRequest } from '../api/client'
import type { ChannelView, MemoryCandidateView, MemoryScope } from '../domain/workspace-view'

export function MemoryCandidateDetail({ candidate, channels, onAccept, onIgnore, onJumpToSource }: {
  candidate: MemoryCandidateView
  channels: ChannelView[]
  onAccept(input: AcceptMemoryCandidateRequest): Promise<void>
  onIgnore(): Promise<void>
  onJumpToSource(channelId: string, messageId: string): void
}) {
  const [content, setContent] = useState(candidate.proposedContent)
  const [scope, setScope] = useState<MemoryScope>(candidate.proposedScope)
  const [channelId, setChannelId] = useState(candidate.channelId ?? channels[0]?.id ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setContent(candidate.proposedContent)
    setScope(candidate.proposedScope)
    setChannelId(candidate.channelId ?? channels[0]?.id ?? '')
    setError(null)
  }, [candidate, channels])
  const submit = async (action: 'accept' | 'ignore') => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      if (action === 'accept') await onAccept({ scope, ...(scope === 'channel' ? { channelId } : {}), content })
      else await onIgnore()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审核操作失败。')
    } finally {
      setSubmitting(false)
    }
  }
  const source = candidate.sources[0]
  return <section className="memory-candidate-detail" aria-label="Memory 候选详情">
    <header><div><span className="memory-kind">{kindLabel(candidate.kind)}</span><h2>候选详情</h2></div><time dateTime={candidate.createdAt}>{formatDate(candidate.createdAt)}</time></header>
    <label>Memory 内容<textarea aria-label="Memory 内容" value={content} onChange={(event) => setContent(event.target.value)} disabled={submitting} /></label>
    <div className="memory-field-row"><label>Scope<select aria-label="Memory Scope" value={scope} disabled={submitting} onChange={(event) => setScope(event.target.value as MemoryScope)}><option value="channel">频道</option><option value="global">全局</option></select></label>{scope === 'channel' && <label>频道<select aria-label="Memory 频道" value={channelId} disabled={submitting} onChange={(event) => setChannelId(event.target.value)}>{channels.map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}</select></label>}</div>
    <p className="memory-rationale">{candidate.rationale}</p>
    {source && <button type="button" className="source-link" onClick={() => onJumpToSource(source.channelId, source.messageId)}><ExternalLink size={15} />跳转到 # {source.channelName} 的来源消息</button>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {candidate.status === 'pending' && <footer><button type="button" className="secondary-action danger-action" disabled={submitting} onClick={() => void submit('ignore')}><X size={16} />忽略候选</button><button type="button" className="primary-action" disabled={submitting || !content.trim() || scope === 'channel' && !channelId} onClick={() => void submit('accept')}><Check size={16} />接受 Memory</button></footer>}
  </section>
}

function kindLabel(kind: MemoryCandidateView['kind']): string {
  return { preference: '偏好', decision: '决策', constraint: '约束', fact: '事实', workflow: '流程' }[kind]
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
