import { Bot, Check, CircleAlert, CornerDownRight, MessageSquareText, Minus } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentView, ChannelMessage, TurnActivityView, TurnResultSummaryView } from '../domain/workspace-view'

export function ChannelTimeline({
  messages,
  agents = [],
  turnActivities = [],
  turnResults = [],
  onOpenThread,
  onOpenTurn,
}: {
  messages: ChannelMessage[]
  agents?: AgentView[]
  turnActivities?: TurnActivityView[]
  turnResults?: TurnResultSummaryView[]
  onOpenThread?(message: ChannelMessage): void
  onOpenTurn?(turnId: string): void
}) {
  const rootMessages = messages.filter((message) => !message.threadRootMessageId)
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const activityGroups = groupActivities(turnActivities)
  const resultsByMessageId = new Map<string, TurnResultSummaryView[]>()
  for (const result of turnResults) resultsByMessageId.set(result.triggerMessageId, [...(resultsByMessageId.get(result.triggerMessageId) ?? []), result])
  return <section className="channel-timeline" aria-label="频道消息" aria-live="polite">
    {rootMessages.length === 0 ? <div className="empty-timeline"><p>这里还没有消息</p><span>发一条消息，或在任务里 @ 指定 Agent。</span></div> : rootMessages.map((message) => <article id={`message-${message.id}`} className={`message message-${message.senderType}`} key={message.id}>
      <div className="message-avatar" aria-hidden="true">{message.senderType === 'agent' ? <Bot size={17} /> : message.senderType === 'system' ? <CornerDownRight size={17} /> : message.authorName.slice(0, 1)}</div>
      <div className="message-copy"><div><strong>{displayAuthorName(message)}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>{message.senderType === 'agent' ? <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown></div> : <p>{message.body}</p>}{onOpenThread && <button type="button" className="message-thread-button" aria-label={`回复 ${displayAuthorName(message)} 的消息`} data-tooltip="在 Thread 中回复" onClick={() => onOpenThread(message)}><MessageSquareText size={15} />{replyCount(messages, message.id) > 0 && <span>{replyCount(messages, message.id)}</span>}</button>}{resultsByMessageId.get(message.id)?.map((result) => <TurnResultSummary key={result.turnId} result={result} agents={agentById} onOpenTurn={onOpenTurn} />)}</div>
    </article>)}
    {activityGroups.length > 0 && <div className="turn-activity-list" aria-label="Turn 活动">
      {activityGroups.map((group) => <div className="turn-activity-group" key={group.turnId} role="status" aria-live="polite">
        <button type="button" className="turn-marker" aria-label={`查看 Turn ${group.turnId} 活动详情`} onClick={() => onOpenTurn?.(group.turnId)}>Turn</button>
        <div className="turn-activity-lines">
          {group.activities.map((activity, index) => <span key={`${activity.turnId}-${activity.agentId ?? 'turn'}-${activity.phase}-${index}`} className="turn-activity-line"><Bot size={14} />{activityLabel(activity, agentById)}</span>)}
        </div>
      </div>)}
    </div>}
  </section>
}

function TurnResultSummary({
  result,
  agents,
  onOpenTurn,
}: {
  result: TurnResultSummaryView
  agents: Map<string, AgentView>
  onOpenTurn?(turnId: string): void
}) {
  const settledParticipants = result.participants.filter((participant) => participant.decision !== 'pending')
  if (settledParticipants.length === 0) return null
  return <div className="turn-result-summary" aria-label={`Turn ${result.turnId} 参与结果`}>
    <button type="button" className="turn-result-marker" onClick={() => onOpenTurn?.(result.turnId)}>Turn 结果</button>
    <div className="turn-result-lines">
      {settledParticipants.map((participant) => {
        const outcome = participantOutcome(participant)
        return <span key={participant.agentId} className={`turn-result-line turn-result-${outcome.kind}`}><OutcomeIcon kind={outcome.kind} /><strong>{agents.get(participant.agentId)?.identity ?? participant.agentId}</strong>{outcome.label}</span>
      })}
    </div>
  </div>
}

function OutcomeIcon({ kind }: { kind: 'judging' | 'participating' | 'silent' | 'replied' | 'failed' }) {
  if (kind === 'replied') return <Check size={13} />
  if (kind === 'failed') return <CircleAlert size={13} />
  if (kind === 'silent') return <Minus size={13} />
  return <span className="turn-result-dot" aria-hidden="true" />
}

function participantOutcome(participant: TurnResultSummaryView['participants'][number]): { kind: 'judging' | 'participating' | 'silent' | 'replied' | 'failed'; label: string } {
  if (participant.status === 'failed') return { kind: 'failed', label: '判断失败' }
  if (participant.status === 'spoken') return { kind: 'replied', label: '已回复' }
  if (participant.decision === 'silent') return { kind: 'silent', label: '未参与' }
  if (participant.decision === 'skipped') return { kind: 'failed', label: '判断失败' }
  if (participant.status === 'skipped') return { kind: 'failed', label: '回复失败' }
  if (participant.decision === 'pending') return { kind: 'judging', label: '正在判断是否参与' }
  return { kind: 'participating', label: participant.status === 'candidate' ? '已决定参与' : '已选中' }
}

function groupActivities(activities: TurnActivityView[]): Array<{ turnId: string; activities: TurnActivityView[] }> {
  const sorted = [...activities].sort((left, right) =>
    left.turnId.localeCompare(right.turnId)
    || phaseRank(left.phase) - phaseRank(right.phase)
    || queueRank(left) - queueRank(right)
    || (left.agentId ?? '').localeCompare(right.agentId ?? ''),
  )
  const groups = new Map<string, TurnActivityView[]>()
  for (const activity of sorted) groups.set(activity.turnId, [...(groups.get(activity.turnId) ?? []), activity])
  return [...groups.entries()].map(([turnId, grouped]) => ({ turnId, activities: grouped }))
}

function queueRank(activity: TurnActivityView): number {
  return activity.queuePosition ?? 9999
}

function phaseRank(phase: TurnActivityView['phase']): number {
  return { screening: 0, judging: 1, queued: 2, preparing: 3, handoff: 4 }[phase]
}

function activityLabel(activity: TurnActivityView, agentById: Map<string, AgentView>): string {
  const agentName = activity.agentId ? agentById.get(activity.agentId)?.identity ?? activity.agentId : null
  if (activity.phase === 'screening') return '正在筛选职责'
  if (activity.phase === 'judging') return `${agentName ?? 'Agent'} 正在判断是否参与`
  if (activity.phase === 'queued') return `${agentName ?? 'Agent'} 排队中${activity.queuePosition ? `（第 ${activity.queuePosition} 位）` : ''}`
  if (activity.phase === 'preparing') return `${agentName ?? 'Agent'} 正在准备回复`
  return agentName ? `${agentName} 正在处理 Handoff` : '正在处理 Handoff'
}

function replyCount(messages: ChannelMessage[], rootMessageId: string): number {
  return messages.filter((message) => message.threadRootMessageId === rootMessageId).length
}

function displayAuthorName(message: ChannelMessage): string {
  if (message.senderType === 'human' && message.authorName === 'You') return '你'
  if (message.senderType === 'system') return '系统'
  return message.authorName
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
