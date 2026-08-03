import { BrainCircuit, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceApi } from '../api/client'
import type { ChannelView, DreamRunView, MemoryCandidateStatus, MemoryCandidateView } from '../domain/workspace-view'
import { MemoryCandidateDetail } from './MemoryCandidateDetail'
import { NavigationToggle } from './RepositorySidebar'

const tabs: Array<{ status: MemoryCandidateStatus; label: string }> = [
  { status: 'pending', label: '待确认' }, { status: 'accepted', label: '已接受' },
  { status: 'ignored', label: '已忽略' }, { status: 'superseded', label: '已替代' },
]
const pollIntervalMs = 750
const pollTimeoutMs = 30_000

export function DreamCenter({
  api, channels, onJumpToSource, refreshGeneration = 0, onOpenNavigation,
}: {
  api: WorkspaceApi
  channels: ChannelView[]
  onJumpToSource(channelId: string, messageId: string): void
  refreshGeneration?: number
  onOpenNavigation?(): void
}) {
  const [status, setStatus] = useState<MemoryCandidateStatus>('pending')
  const [candidates, setCandidates] = useState<MemoryCandidateView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dreamScope, setDreamScope] = useState('all')
  const [dreamNotice, setDreamNotice] = useState<string | null>(null)
  const [dreamError, setDreamError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [activeRunIds, setActiveRunIds] = useState<string[]>([])
  const candidateRequest = useRef(0)
  const tabToFocus = useRef<MemoryCandidateStatus | null>(null)
  const running = starting || activeRunIds.length > 0
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null

  const load = useCallback(async (nextStatus: MemoryCandidateStatus) => {
    const request = ++candidateRequest.current
    setLoading(true)
    setError(null)
    try {
      const next = await api.listMemoryCandidates(nextStatus)
      if (request !== candidateRequest.current) return
      setCandidates(next)
      setSelectedId((current) => next.some((candidate) => candidate.id === current) ? current : next[0]?.id ?? null)
    } catch (cause) {
      if (request === candidateRequest.current) setError(cause instanceof Error ? cause.message : '无法读取 Memory 候选。')
    } finally {
      if (request === candidateRequest.current) setLoading(false)
    }
  }, [api])

  useEffect(() => { void load(status) }, [load, refreshGeneration, status])
  useEffect(() => {
    if (!tabToFocus.current) return
    document.getElementById(`memory-candidate-tab-${tabToFocus.current}`)?.focus()
    tabToFocus.current = null
  }, [status])

  const finishRuns = useCallback((runs: DreamRunView[]) => {
    const failed = runs.find((run) => run.status === 'failed' || run.status === 'cancelled')
    setActiveRunIds([])
    if (failed) {
      setDreamError(`Dream 运行失败：${failed.error ?? (failed.status === 'cancelled' ? '运行已取消' : '未知错误')}`)
      return
    }
    const candidateCount = runs.reduce((total, run) => total + run.candidateCount, 0)
    setDreamNotice(candidateCount === 0 ? 'Dream 已完成，没有新增候选。' : `Dream 已完成，新增 ${candidateCount} 条候选。`)
    if (candidateCount > 0) {
      setStatus('pending')
      setSelectedId(null)
    }
  }, [])

  useEffect(() => {
    if (activeRunIds.length === 0) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const poll = async () => {
      try {
        const runs = await api.listDreamRuns()
        if (cancelled) return
        const targetRuns = activeRunIds.map((id) => runs.find((run) => run.id === id)).filter((run): run is DreamRunView => Boolean(run))
        if (targetRuns.length === activeRunIds.length && targetRuns.every((run) => isTerminal(run))) {
          finishRuns(targetRuns)
          return
        }
        if (Date.now() - startedAt >= pollTimeoutMs) {
          setActiveRunIds([])
          setDreamError('Dream 运行状态查询超时，请稍后刷新。')
          return
        }
        timer = setTimeout(() => void poll(), pollIntervalMs)
      } catch (cause) {
        if (cancelled) return
        setActiveRunIds([])
        setDreamError(`Dream 运行状态查询失败：${cause instanceof Error ? cause.message : '未知错误'}`)
      }
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [activeRunIds, api, finishRuns, refreshGeneration])

  const selectTab = (nextStatus: MemoryCandidateStatus) => {
    setStatus(nextStatus)
    setSelectedId(null)
  }
  const moveTab = (currentIndex: number, direction: -1 | 1) => {
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
    const next = tabs[nextIndex]
    tabToFocus.current = next.status
    selectTab(next.status)
  }
  const startDream = async () => {
    if (running) return
    setStarting(true)
    setDreamNotice('Dream 正在运行...')
    setDreamError(null)
    try {
      const runs = await api.startDream(dreamScope === 'all' ? undefined : dreamScope)
      if (runs.length === 0) {
        setDreamNotice('没有可运行的活跃频道。')
      } else if (runs.every(isTerminal)) {
        finishRuns(runs)
      } else {
        setActiveRunIds(runs.map((run) => run.id))
      }
    } catch (cause) {
      setDreamError(`Dream 运行失败：${cause instanceof Error ? cause.message : '未知错误'}`)
    } finally {
      setStarting(false)
    }
  }
  const review = async (action: 'accept' | 'ignore', candidate: MemoryCandidateView, input?: Parameters<WorkspaceApi['acceptMemoryCandidate']>[1]) => {
    if (action === 'accept' && input) await api.acceptMemoryCandidate(candidate.id, input)
    if (action === 'ignore') await api.ignoreMemoryCandidate(candidate.id)
    selectTab(action === 'accept' ? 'accepted' : 'ignored')
  }

  return <main className="dream-center" aria-label="Dream Center">
    <header className="dream-header"><div className="dream-heading"><NavigationToggle onClick={onOpenNavigation ?? (() => undefined)} /><div><div className="dream-title"><BrainCircuit size={22} /><h1>Dream Center</h1></div><p>审核 Dream 提炼出的长期 Memory。</p></div></div><div className="dream-run-controls"><label>Dream 范围<select aria-label="Dream 范围" value={dreamScope} disabled={running} onChange={(event) => setDreamScope(event.target.value)}><option value="all">全部活跃频道</option>{channels.filter((channel) => !channel.archivedAt).map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}</select></label><button type="button" className="primary-action" disabled={running} onClick={() => void startDream()}>{running ? <RefreshCw className="spin" size={16} /> : <BrainCircuit size={16} />}立即 Dream</button></div></header>
    {dreamNotice && <p className="dream-notice" role="status">{dreamNotice}</p>}
    {dreamError && <p className="form-error dream-error" role="alert">{dreamError}</p>}
    <div className="dream-tabs" role="tablist" aria-label="Memory 审核状态">{tabs.map((tab, index) => <button type="button" key={tab.status} id={`memory-candidate-tab-${tab.status}`} role="tab" tabIndex={status === tab.status ? 0 : -1} aria-selected={status === tab.status} aria-controls={`memory-candidate-panel-${tab.status}`} onClick={() => selectTab(tab.status)} onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(index, -1) } if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(index, 1) } }}>{tab.label}</button>)}</div>
    <div className="dream-review-layout"><section id={`memory-candidate-panel-${status}`} className="memory-candidate-list" role="tabpanel" aria-labelledby={`memory-candidate-tab-${status}`} aria-label={`${tabs.find((tab) => tab.status === status)?.label}候选`}>
      {loading ? <p className="dream-empty">正在读取候选...</p> : error ? <div className="dream-empty"><p role="alert">{error}</p><button type="button" className="secondary-action" onClick={() => void load(status)}>重试</button></div> : candidates.length === 0 ? <p className="dream-empty">此状态下没有候选。</p> : candidates.map((candidate) => <button type="button" key={candidate.id} className="memory-candidate-row" aria-pressed={candidate.id === selectedId} onClick={() => setSelectedId(candidate.id)}><span className="memory-kind">{displayScope(candidate) === 'global' ? '全局' : '频道'}</span><strong>{displayContent(candidate)}</strong><small>频道 · {candidate.sources[0]?.channelName ?? '未知'} · {candidate.sourceMessageCount} 条来源</small><time dateTime={candidate.createdAt}>{formatDate(candidate.createdAt)}</time></button>)}</section>
      <div className="memory-detail-slot">{selected ? <MemoryCandidateDetail candidate={selected} channels={channels} onJumpToSource={onJumpToSource} onAccept={(input) => review('accept', selected, input)} onIgnore={() => review('ignore', selected)} /> : <p className="dream-empty">选择一个候选查看详情。</p>}</div>
    </div>
  </main>
}

function isTerminal(run: DreamRunView): boolean { return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' }
function displayContent(candidate: MemoryCandidateView): string { return candidate.status === 'pending' ? candidate.proposedContent : candidate.reviewedContent ?? candidate.proposedContent }
function displayScope(candidate: MemoryCandidateView): MemoryCandidateView['proposedScope'] { return candidate.status === 'pending' ? candidate.proposedScope : candidate.reviewedScope ?? candidate.proposedScope }
function formatDate(value: string): string { return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) }
