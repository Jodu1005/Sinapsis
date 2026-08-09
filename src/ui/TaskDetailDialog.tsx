import { MessageSquareText, Terminal, X } from 'lucide-react'
import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentView, TaskDetailView, TaskEventView, TaskInputView, TaskSessionView, TaskView } from '../domain/workspace-view'
import { TaskProcessConsole } from './TaskProcessConsole'
import { TaskOutputFiles } from './TaskOutputFiles'
import { useModalDialog } from './useModalDialog'

export function TaskDetailDialog({ task, details, agents, error, onComment, onRetryAnalysis, onReadArtifact, onListOutputFiles, onReadOutputFile, onClose }: {
  task: TaskView
  details: TaskDetailView | null
  agents: AgentView[]
  error: string | null
  onComment?(body: string): Promise<void>
  onRetryAnalysis?(): Promise<void>
  onReadArtifact?(artifactId: string): Promise<string>
  onListOutputFiles?(taskId: string): Promise<Array<{ path: string; status: 'added' | 'modified' | 'renamed' }>>
  onReadOutputFile?(taskId: string, filePath: string): Promise<string>
  onClose(): void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(onClose, closeRef)
  const [commenting, setCommenting] = useState(false)
  const [retryingAnalysis, setRetryingAnalysis] = useState(false)
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null)
  const [view, setView] = useState<'reply' | 'process'>('reply')
  const replyEvents = details?.events.filter((event) => event.type === 'runtime.text') ?? []
  const replyGroups = groupReplyEvents(replyEvents, details?.sessions ?? [], details?.inputs ?? [])
  const comments = details?.comments ?? []
  const analysisComment = [...comments].reverse().find((comment) => comment.senderType === 'agent')
  const agentId = analysisComment?.senderId ?? details?.sessions.at(-1)?.agentId ?? task.lastAgentId ?? task.directAgentId
  const agent = agents.find((candidate) => candidate.id === agentId)
  const addComment = async (body: string) => {
    if (!onComment || commenting) return
    setCommenting(true)
    try { await onComment(body) } finally { setCommenting(false) }
  }
  const retryAnalysis = async () => {
    if (!onRetryAnalysis || retryingAnalysis) return
    setRetryingAnalysis(true)
    setAnalysisNotice(null)
    try {
      await onRetryAnalysis()
      setAnalysisNotice('Agent 正在准备回答...')
    } catch (cause) {
      setAnalysisNotice(cause instanceof Error ? cause.message : '无法重新发起积压分析。')
    } finally { setRetryingAnalysis(false) }
  }
  return <div className="panel-scrim task-detail-scrim" role="presentation"><section ref={dialogRef} className="task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="task-detail-dialog-title">
    <header><div><p>{agent ? `${task.status === 'backlog' ? '分析 Agent' : '处理 Agent'} · @${agent.identity} · ${agent.runtime}` : task.status === 'backlog' ? '正在分析任务' : '任务处理详情'}</p><h2 id="task-detail-dialog-title">{task.title}</h2><div className="task-detail-timestamps"><time dateTime={task.createdAt}>创建 {formatCommentTime(task.createdAt)}</time><time dateTime={task.updatedAt}>更新 {formatCommentTime(task.updatedAt)}</time></div></div><div className="task-detail-header-actions">{task.status !== 'backlog' && onReadArtifact && <div className="task-detail-tabs" role="tablist" aria-label="任务详情视图"><button type="button" role="tab" aria-selected={view === 'reply'} onClick={() => setView('reply')}><MessageSquareText size={15} />回复</button><button type="button" role="tab" aria-selected={view === 'process'} onClick={() => setView('process')}><Terminal size={15} />执行过程</button></div>}<button ref={closeRef} type="button" className="icon-button" aria-label="关闭任务详情" data-tooltip="关闭" onClick={onClose}><X size={18} /></button></div></header>
    <div className="task-detail-dialog-body">{details ? task.status === 'backlog' ? <section className="task-comment-panel"><div className="task-comment-heading"><div><h3>积压分析</h3><p>任务仍在积压中，确认成熟后由人类移入待办。</p>{analysisNotice && <p className="task-analysis-notice" role="status">{analysisNotice}</p>}</div>{(onComment || onRetryAnalysis) && <div className="task-comment-actions">{onRetryAnalysis && <button type="button" className="secondary-action" disabled={retryingAnalysis} onClick={() => void retryAnalysis()}>{retryingAnalysis ? '正在重新分析...' : '重新分析'}</button>}{onComment && <><button type="button" className="secondary-action" disabled={commenting} onClick={() => void addComment('我同意这份积压分析，可以继续完善并准备进入待办。')}>同意分析</button><button type="button" className="secondary-action" disabled={commenting} onClick={() => void addComment('我不同意当前分析，需要继续明确范围、风险或完成定义。')}>提出异议</button></>}</div>}</div><ol className="task-comment-list" aria-label="任务评论">{comments.length > 0 ? comments.map((comment) => <li key={comment.id} data-author={comment.senderType}><header><strong>{comment.authorName}</strong><small>{formatCommentTime(comment.createdAt)}</small></header><div className="task-comment-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown></div></li>) : <li className="task-comment-empty">正在等待 Agent 的积压分析...</li>}</ol></section> : view === 'process' && onReadArtifact ? <TaskProcessConsole artifacts={details.artifacts} onReadArtifact={onReadArtifact} /> : <section className="agent-reply-panel"><div className="agent-reply-heading"><h3>Agent 回复</h3></div>{replyGroups.length > 0 ? <div className="agent-reply-stack" aria-label="Agent 回复列表">{replyGroups.map((reply) => <article key={reply.id} className="agent-reply-surface" aria-label="Agent 回复内容"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reply.text}</ReactMarkdown><time className="agent-reply-time" dateTime={reply.createdAt}>{formatReplyByline(agents.find((candidate) => candidate.id === reply.agentId), reply.createdAt)}</time></article>)}</div> : <p>Agent 尚未返回内容</p>}{onListOutputFiles && onReadOutputFile && <TaskOutputFiles taskId={task.id} onListFiles={onListOutputFiles} onReadFile={onReadOutputFile} />}</section> : <p className="task-detail-loading" role={error ? 'alert' : undefined}>{error ?? (task.status === 'backlog' ? '正在读取积压分析...' : '正在读取 Agent 回复...')}</p>}</div>
  </section></div>
}

function groupReplyEvents(events: TaskEventView[], sessions: TaskSessionView[], inputs: TaskInputView[]): { id: string; agentId: string | null; text: string; createdAt: string }[] {
  const sortedSessions = [...sessions].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
  const consumedInputTimes = inputs.map((input) => input.consumedAt).filter((value): value is string => Boolean(value)).sort()
  const groups: { id: string; agentId: string | null; text: string; createdAt: string }[] = []

  for (const event of events) {
    if (typeof event.payload.text !== 'string') continue
    const text = collapseRepeatedText(event.payload.text)
    if (!text.trim()) continue

    const eventTime = new Date(event.createdAt).getTime()
    const session = [...sortedSessions].reverse().find((candidate) => new Date(candidate.createdAt).getTime() <= eventTime)
    const consumedInputCount = consumedInputTimes.filter((value) => new Date(value).getTime() <= eventTime).length
    const groupId = `${session?.id ?? event.id}:${consumedInputCount}`
    const existing = groups.find((group) => group.id === groupId)
    if (existing) {
      existing.text += text
      existing.createdAt = event.createdAt
    } else {
      groups.push({ id: groupId, agentId: session?.agentId ?? null, text, createdAt: event.createdAt })
    }
  }

  return groups
}

function formatReplyByline(agent: AgentView | undefined, createdAt: string): string {
  return agent ? `${agent.identity} agent 回复 ${formatCommentTime(createdAt)}` : `Agent 回复 ${formatCommentTime(createdAt)}`
}

function collapseRepeatedText(text: string): string {
  if (text.length % 2 !== 0) return text
  const halfway = text.length / 2
  return text.slice(0, halfway) === text.slice(halfway) ? text.slice(0, halfway) : text
}

function formatCommentTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
