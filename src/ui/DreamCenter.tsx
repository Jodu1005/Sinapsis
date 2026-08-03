import { BrainCircuit, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceApi } from '../api/client'
import type { ChannelView, MemoryCandidateStatus, MemoryCandidateView } from '../domain/workspace-view'
import { MemoryCandidateDetail } from './MemoryCandidateDetail'

const tabs: Array<{ status: MemoryCandidateStatus; label: string }> = [
  { status: 'pending', label: '待确认' }, { status: 'accepted', label: '已接受' },
  { status: 'ignored', label: '已忽略' }, { status: 'superseded', label: '已替代' },
]

export function DreamCenter({ api, channels, onJumpToSource }: { api: WorkspaceApi; channels: ChannelView[]; onJumpToSource(channelId: string, messageId: string): void }) {
  const [status, setStatus] = useState<MemoryCandidateStatus>('pending')
  const [candidates, setCandidates] = useState<MemoryCandidateView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dreamScope, setDreamScope] = useState('all')
  const [dreamNotice, setDreamNotice] = useState<string | null>(null)
  const [dreamError, setDreamError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const load = useCallback(async (nextStatus = status) => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.listMemoryCandidates(nextStatus)
      setCandidates(next)
      setSelectedId((current) => next.some((candidate) => candidate.id === current) ? current : next[0]?.id ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取 Memory 候选。')
    } finally {
      setLoading(false)
    }
  }, [api, status])
  useEffect(() => { void load() }, [load])
  const selectTab = (nextStatus: MemoryCandidateStatus) => { setStatus(nextStatus); setSelectedId(null) }
  const startDream = async () => {
    if (running) return
    setRunning(true)
    setDreamNotice('Dream 正在运行...')
    setDreamError(null)
    try {
      const runs = await api.startDream(dreamScope === 'all' ? undefined : dreamScope)
      const failed = runs.find((run) => run.status === 'failed')
      if (failed) setDreamError(`Dream 运行失败：${failed.error ?? '未知错误'}`)
      else if (runs.every((run) => run.status === 'completed') && runs.every((run) => run.candidateCount === 0)) setDreamNotice('Dream 已完成，没有新增候选。')
      else setDreamNotice('Dream 已提交，正在处理候选。')
      await load('pending')
    } catch (cause) {
      setDreamError(`Dream 运行失败：${cause instanceof Error ? cause.message : '未知错误'}`)
    } finally {
      setRunning(false)
    }
  }
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null
  const review = async (action: 'accept' | 'ignore', candidate: MemoryCandidateView, input?: Parameters<WorkspaceApi['acceptMemoryCandidate']>[1]) => {
    if (action === 'accept' && input) await api.acceptMemoryCandidate(candidate.id, input)
    if (action === 'ignore') await api.ignoreMemoryCandidate(candidate.id)
    const nextStatus = action === 'accept' && status === 'pending' ? 'accepted' : status
    if (nextStatus !== status) setStatus(nextStatus)
    await load(nextStatus)
  }
  return <main className="dream-center" aria-label="Dream Center">
    <header className="dream-header"><div><div className="dream-title"><BrainCircuit size={22} /><h1>Dream Center</h1></div><p>审核 Dream 提炼出的长期 Memory。</p></div><div className="dream-run-controls"><label>Dream 范围<select aria-label="Dream 范围" value={dreamScope} disabled={running} onChange={(event) => setDreamScope(event.target.value)}><option value="all">全部活跃频道</option>{channels.filter((channel) => !channel.archivedAt).map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}</select></label><button type="button" className="primary-action" disabled={running} onClick={() => void startDream()}>{running ? <RefreshCw className="spin" size={16} /> : <BrainCircuit size={16} />}立即 Dream</button></div></header>
    {dreamNotice && <p className="dream-notice" role="status">{dreamNotice}</p>}
    {dreamError && <p className="form-error dream-error" role="alert">{dreamError}</p>}
    <div className="dream-tabs" role="tablist" aria-label="Memory 审核状态">{tabs.map((tab) => <button type="button" key={tab.status} role="tab" aria-selected={status === tab.status} onClick={() => selectTab(tab.status)}>{tab.label}</button>)}</div>
    <div className="dream-review-layout"><section className="memory-candidate-list" aria-label={`${tabs.find((tab) => tab.status === status)?.label}候选`}>
      {loading ? <p className="dream-empty">正在读取候选...</p> : error ? <div className="dream-empty"><p role="alert">{error}</p><button type="button" className="secondary-action" onClick={() => void load()}>重试</button></div> : candidates.length === 0 ? <p className="dream-empty">此状态下没有候选。</p> : candidates.map((candidate) => <button type="button" key={candidate.id} className="memory-candidate-row" aria-pressed={candidate.id === selectedId} onClick={() => setSelectedId(candidate.id)}><span className="memory-kind">{candidate.proposedScope === 'global' ? '全局' : '频道'}</span><strong>{candidate.proposedContent}</strong><small>频道 · {candidate.sources[0]?.channelName ?? '未知'} · {candidate.sourceMessageCount} 条来源</small><time dateTime={candidate.createdAt}>{formatDate(candidate.createdAt)}</time></button>)}</section>
      <div className="memory-detail-slot">{selected ? <MemoryCandidateDetail candidate={selected} channels={channels} onJumpToSource={onJumpToSource} onAccept={(input) => review('accept', selected, input)} onIgnore={() => review('ignore', selected)} /> : <p className="dream-empty">选择一个候选查看详情。</p>}</div>
    </div>
  </main>
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
