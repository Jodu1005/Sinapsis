import { X, ListChecks, Route, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { AgentView, AgentInvocationView, ConversationHandoffView, ConversationTurnDetailView, TurnParticipantView } from '../domain/workspace-view'

export function ConversationTurnDetail({
  detail,
  agents,
  onCancel,
}: {
  detail: ConversationTurnDetailView
  agents: AgentView[]
  onCancel?(): Promise<void>
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const agentById = new Map(agents.map((agent) => [agent.id, agent]))
  const failedParticipants = detail.participants.filter(hasParticipantFailureDetail)
  const failedInvocations = detail.invocations.filter((invocation) => invocation.errorCategory)
  const failedHandoffs = detail.handoffs.filter((handoff) => handoff.status === 'failed' || handoff.status === 'rejected' || handoff.reason)
  const failures = [
    ...failedParticipants,
    ...failedInvocations,
    ...failedHandoffs,
  ]
  const canCancel = Boolean(onCancel && !isTerminalTurnStatus(detail.turn.status))

  const cancelTurn = async () => {
    if (!onCancel || cancelling) return
    setCancelling(true)
    setCancelError(null)
    try {
      await onCancel()
    } catch (cause) {
      setCancelError(cause instanceof Error ? cause.message : '无法取消 Turn。')
    } finally {
      setCancelling(false)
    }
  }

  return <section className="turn-detail-panel" aria-label="Turn 详情">
    <div className="detail-section turn-detail-summary">
      <h3>对话回合</h3>
      <div className="turn-detail-title">
        <h2>Turn {detail.turn.id}</h2>
        <span>{turnStatusLabel(detail.turn.status)}</span>
      </div>
      <dl className="turn-detail-meta">
        <div><dt>轮次</dt><dd>{`第 ${detail.turn.currentRound} / ${detail.turn.maxRounds} 轮`}</dd></div>
        <div><dt>模式</dt><dd>{turnModeLabel(detail.turn.mode)}</dd></div>
      </dl>
      {canCancel && <div className="turn-cancel-row">
        {!confirmingCancel ? <button type="button" className="context-small-action context-danger" onClick={() => { setConfirmingCancel(true); setCancelError(null) }}><X size={14} />取消 Turn</button> : <div className="turn-cancel-confirm">
          <button type="button" className="danger-action" disabled={cancelling} onClick={() => void cancelTurn()}><X size={14} />{cancelling ? '正在取消...' : `确认取消 Turn ${detail.turn.id}`}</button>
          <button type="button" className="secondary-action" disabled={cancelling} onClick={() => { setConfirmingCancel(false); setCancelError(null) }}>保留 Turn</button>
        </div>}
        {cancelError && <p className="form-error" role="alert">{cancelError}</p>}
      </div>}
    </div>

    <section className="detail-section">
      <h3>候选 Agent</h3>
      {detail.participants.length === 0 ? <p className="context-empty">没有候选记录</p> : <ol className="turn-detail-list">
        {detail.participants.map((participant) => <li key={participant.id}>
          <div className="turn-detail-row-head">
            <strong>{agentName(participant.agentId, agentById)}</strong>
            <span>{participantOrder(participant)}</span>
          </div>
          <dl>
            <div><dt>决策</dt><dd>{decisionLabel(participant.decision)} · {participantStatusLabel(participant.status)}</dd></div>
            <div><dt>理由</dt><dd>{participant.reason ?? '未提供'}</dd></div>
            {participant.proposedAngle && <div><dt>角度</dt><dd>{participant.proposedAngle}</dd></div>}
            {participant.confidence !== null && <div><dt>置信度</dt><dd>{Math.round(participant.confidence * 100)}%</dd></div>}
          </dl>
        </li>)}
      </ol>}
    </section>

    <section className="detail-section">
      <h3>调用状态</h3>
      {detail.invocations.length === 0 ? <p className="context-empty">没有调用记录</p> : <ul className="turn-detail-list">
        {detail.invocations.map((invocation) => <li key={invocation.id}>
          <div className="turn-detail-row-head">
            <strong>{agentName(invocation.agentId, agentById)}</strong>
            <span>第 {invocation.round} 轮</span>
          </div>
          <p><ListChecks size={14} /><span>{invocationKindLabel(invocation.kind)} · {invocationStatusLabel(invocation)}</span>{invocation.errorCategory && <span className="turn-error-chip">{errorCategoryLabel(invocation.errorCategory)}</span>}</p>
        </li>)}
      </ul>}
    </section>

    <section className="detail-section">
      <h3>Handoff 路径</h3>
      {detail.handoffs.length === 0 ? <p className="context-empty">没有 Handoff</p> : <ul className="turn-detail-list">
        {detail.handoffs.map((handoff) => <li key={handoff.id}>
          <div className="turn-detail-row-head">
            <strong>{handoffPath(handoff, agentById)}</strong>
            <span>第 {handoff.round} 轮</span>
          </div>
          <p><Route size={14} />{handoff.question}</p>
          <small>{handoffStatusLabel(handoff.status)}{handoff.reason ? ` · ${handoff.reason}` : ''}</small>
        </li>)}
      </ul>}
    </section>

    {failures.length > 0 && <section className="detail-section">
      <details className="turn-failure-details">
        <summary><ShieldAlert size={14} />失败详情</summary>
        <ul>
          {failedParticipants.map((participant) => <li key={`participant-${participant.id}`}>{agentName(participant.agentId, agentById)}：{participant.reason ?? participantStatusLabel(participant.status)}</li>)}
          {failedInvocations.map((invocation) => <li key={`invocation-${invocation.id}`}>{agentName(invocation.agentId, agentById)}：{errorCategoryLabel(invocation.errorCategory!)}</li>)}
          {failedHandoffs.map((handoff) => <li key={`handoff-${handoff.id}`}>{handoffPath(handoff, agentById)}：{handoff.reason ?? handoffStatusLabel(handoff.status)}</li>)}
        </ul>
      </details>
    </section>}
  </section>
}

function agentName(agentId: string, agentById: Map<string, AgentView>): string {
  return agentById.get(agentId)?.identity ?? agentId
}

function participantOrder(participant: TurnParticipantView): string {
  if (participant.speakingOrder !== null) return `第 ${participant.speakingOrder} 位`
  return `候选 ${participant.rank + 1}`
}

function handoffPath(handoff: ConversationHandoffView, agentById: Map<string, AgentView>): string {
  return `${agentName(handoff.fromAgentId, agentById)} -> ${handoff.toAgentId ? agentName(handoff.toAgentId, agentById) : agentName(handoff.requestedTargetAgentId, agentById)}`
}

function turnModeLabel(mode: ConversationTurnDetailView['turn']['mode']): string {
  return { ordinary: '普通消息', direct: '直接提及', multi_direct: '多 Agent 提及', all: '@all' }[mode]
}

function turnStatusLabel(status: ConversationTurnDetailView['turn']['status']): string {
  return {
    screening: '筛选中', judging: '判断中', responding: '回复中', handoff: 'Handoff',
    completed: '已完成', partial: '部分完成', cancelled: '已取消', failed: '失败', interrupted: '已中断',
  }[status]
}

function decisionLabel(decision: TurnParticipantView['decision']): string {
  return { pending: '待判断', speak: '参与', silent: '静默', skipped: '跳过' }[decision]
}

function participantStatusLabel(status: TurnParticipantView['status']): string {
  return { candidate: '候选', selected: '已选择', spoken: '已发言', failed: '失败', skipped: '已跳过', cancelled: '已取消' }[status]
}

function hasParticipantFailureDetail(participant: TurnParticipantView): boolean {
  if (participant.status === 'failed') return true
  return participant.status === 'skipped' && isControlledParticipantFailure(participant.reason)
}

function isControlledParticipantFailure(reason: string | null): boolean {
  return reason === 'participation_failed' || reason === 'response_failed' || reason === 'coordinator_failed'
}

function isTerminalTurnStatus(status: ConversationTurnDetailView['turn']['status']): boolean {
  return status === 'completed' || status === 'partial' || status === 'cancelled' || status === 'failed' || status === 'interrupted'
}

function invocationKindLabel(kind: AgentInvocationView['kind']): string {
  return { participation: '参与判断', response: '正式回复', duplicate_check: '重复检查', handoff_response: 'Handoff 回复' }[kind]
}

function invocationStatusLabel(invocation: AgentInvocationView): string {
  return { queued: '排队中', running: '运行中', settled: '已完成', failed: '失败', cancelled: '已取消' }[invocation.status]
}

function errorCategoryLabel(category: NonNullable<AgentInvocationView['errorCategory']>): string {
  return { timeout: '超时', cancelled: '已取消', runtime_failure: 'Runtime 失败' }[category]
}

function handoffStatusLabel(status: ConversationHandoffView['status']): string {
  return { queued: '排队中', accepted: '已接受', rejected: '已拒绝', completed: '已完成', failed: '失败' }[status]
}
