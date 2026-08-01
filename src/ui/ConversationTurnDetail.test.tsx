import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentView, ConversationTurnDetailView } from '../domain/workspace-view'
import { ConversationTurnDetail } from './ConversationTurnDetail'

const agents: AgentView[] = [
  {
    id: 'agent-newton', identity: 'Newton', mentionName: 'newton', runtime: 'pi', status: 'idle',
    capabilityTags: ['frontend'], maxConcurrentTasks: 1, command: 'pi', args: [], model: '', env: [], createdAt: '', updatedAt: '',
  },
  {
    id: 'agent-clawd', identity: 'Clawd', mentionName: 'clawd', runtime: 'claude-code', status: 'busy',
    capabilityTags: ['test'], maxConcurrentTasks: 1, command: 'claude', args: [], model: '', env: [], createdAt: '', updatedAt: '',
  },
]

const detail = {
  turn: {
    id: 'turn-1',
    channelId: 'channel-1',
    triggerMessageId: 'message-1',
    threadRootMessageId: null,
    mode: 'ordinary',
    status: 'partial',
    currentRound: 2,
    maxRounds: 3,
    createdAt: '2026-07-31T08:00:00.000Z',
    updatedAt: '2026-07-31T08:05:00.000Z',
    completedAt: '2026-07-31T08:05:00.000Z',
  },
  participants: [
    {
      id: 'participant-1',
      turnId: 'turn-1',
      agentId: 'agent-newton',
      source: 'responsibility',
      rank: 0,
      matcherScore: 18,
      decision: 'speak',
      confidence: 0.84,
      proposedAngle: '检查表单交互',
      dependsOnAgentId: null,
      speakingOrder: 1,
      status: 'spoken',
      reason: '职责命中 React 表单',
      createdAt: '2026-07-31T08:00:00.000Z',
      updatedAt: '2026-07-31T08:01:00.000Z',
    },
    {
      id: 'participant-2',
      turnId: 'turn-1',
      agentId: 'agent-clawd',
      source: 'handoff',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      confidence: 0.71,
      proposedAngle: '补齐失败路径测试',
      dependsOnAgentId: 'agent-newton',
      speakingOrder: 2,
      status: 'failed',
      reason: 'participation_failed',
      createdAt: '2026-07-31T08:01:00.000Z',
      updatedAt: '2026-07-31T08:04:00.000Z',
    },
  ],
  invocations: [
    {
      id: 'invocation-1',
      turnId: 'turn-1',
      agentId: 'agent-newton',
      kind: 'response',
      priority: 'human_ordinary',
      round: 1,
      status: 'settled',
      sourceInvocationId: null,
      queuedAt: '2026-07-31T08:01:00.000Z',
      startedAt: '2026-07-31T08:01:01.000Z',
      completedAt: '2026-07-31T08:02:00.000Z',
      errorCategory: null,
    },
    {
      id: 'invocation-2',
      turnId: 'turn-1',
      agentId: 'agent-clawd',
      kind: 'handoff_response',
      priority: 'automatic_handoff',
      round: 2,
      status: 'failed',
      sourceInvocationId: 'invocation-1',
      queuedAt: '2026-07-31T08:03:00.000Z',
      startedAt: '2026-07-31T08:03:01.000Z',
      completedAt: '2026-07-31T08:04:00.000Z',
      errorCategory: 'timeout',
    },
  ],
  handoffs: [{
    id: 'handoff-1',
    turnId: 'turn-1',
    sourceInvocationId: 'invocation-1',
    fromAgentId: 'agent-newton',
    requestedTargetAgentId: 'agent-clawd',
    toAgentId: 'agent-clawd',
    question: '请确认测试覆盖是否完整',
    round: 2,
    status: 'rejected',
    reason: 'coordinator_failed',
    createdAt: '2026-07-31T08:02:30.000Z',
    updatedAt: '2026-07-31T08:03:00.000Z',
  }],
  rawRuntimeLog: 'Runtime raw output should stay private',
  prompt: 'Prompt should stay private',
  participationJson: '{"decision":"speak"}',
} satisfies ConversationTurnDetailView & Record<string, unknown>

describe('ConversationTurnDetail', () => {
  it('renders the public turn DTO without leaking raw internal fields', () => {
    const { container } = render(<ConversationTurnDetail detail={detail} agents={agents} />)

    expect(screen.getByRole('heading', { name: 'Turn turn-1' })).toBeInTheDocument()
    expect(screen.getByText('第 2 / 3 轮')).toBeInTheDocument()
    expect(screen.getByText('候选 Agent')).toBeInTheDocument()
    expect(screen.getAllByText('Newton').length).toBeGreaterThan(0)
    expect(screen.getByText('职责命中 React 表单')).toBeInTheDocument()
    expect(screen.getByText('检查表单交互')).toBeInTheDocument()
    expect(screen.getByText('调用状态')).toBeInTheDocument()
    expect(screen.getAllByText(/第 2 轮/).length).toBeGreaterThan(0)
    expect(screen.getByText('超时')).toBeInTheDocument()
    expect(screen.getByText('Handoff 路径')).toBeInTheDocument()
    expect(screen.getAllByText('Newton -> Clawd').length).toBeGreaterThan(0)
    expect(screen.getByText('请确认测试覆盖是否完整')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toHaveAttribute('open')
    const turnDetail = screen.getByRole('region', { name: 'Turn 详情' })
    expect(within(turnDetail).queryByText(/Runtime raw output/)).not.toBeInTheDocument()
    expect(within(turnDetail).queryByText(/Prompt should stay private/)).not.toBeInTheDocument()
    expect(within(turnDetail).queryByText(/"decision"/)).not.toBeInTheDocument()
  })
})
