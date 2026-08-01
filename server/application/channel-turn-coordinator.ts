import { randomUUID } from 'node:crypto'
import type { RuntimeKind } from '../adapters/runtime/runtime-profile'
import type { Agent } from '../domain/agent'
import type {
  AgentInvocation,
  ConversationTurn,
  InvocationKind,
  InvocationPriority,
  TurnParticipant,
} from '../domain/conversation'
import type { DomainEvent } from '../domain/events'
import type { Message } from '../domain/message'
import { DomainError } from '../domain/task'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import type { WorkspaceRepositories } from '../ports/repositories'
import type { RuntimeAdapter } from '../ports/runtime'
import {
  AgentInvocationQueue,
  AgentInvocationQueueCancelledError,
  type AgentInvocationCancellationResult,
  type QueuedInvocation,
} from './agent-invocation-queue'
import type {
  DuplicateDecision,
  PublicAgentResponse,
  RuntimeConversationCall,
} from './agent-conversation-protocol'
import { ChannelMessageService } from './channel-message-service'
import {
  ConversationInvocationCancelledError,
  ConversationSessionService,
  type ConversationSessionInvocation,
  type ConversationSessionResult,
} from './conversation-session-service'
import { ContextAssembler } from './context-assembler'
import { HandoffPolicy } from './handoff-policy'
import { routeMentions, UnknownMentionError } from './mention-router'
import { ParticipationService } from './participation-service'
import { matchResponsibilities } from './responsibility-matcher'

export interface TurnActivity {
  turnId: string
  agentId: string | null
  phase: 'screening' | 'judging' | 'queued' | 'preparing' | 'handoff'
  queuePosition: number | null
}

export interface ChannelTurnStart {
  turn: ConversationTurn
  completion: Promise<ConversationTurn>
}

interface ConversationSessions {
  invoke(input: ConversationSessionInvocation): Promise<ConversationSessionResult>
  cancelChannel(channelId: string): Promise<{ cancelledSessionKeys: string[] }>
  cancelAgentInChannel(channelId: string, agentId: string): Promise<{ cancelledSessionKeys: string[] }>
  cancelInvocation(invocationId: string): Promise<{ invocationId: string; cancelledSessionKeys: string[] }>
}

interface InvocationQueue {
  enqueue<T>(invocation: QueuedInvocation<T>): Promise<T>
  cancel(predicate: (invocation: QueuedInvocation<unknown>) => boolean): void
  cancelInvocation(invocationId: string): AgentInvocationCancellationResult
  snapshot(agentId: string): { running: boolean; queued: number }
}

export interface ChannelTurnCoordinatorOptions {
  repositories: WorkspaceRepositories
  runtimes?: Partial<Record<RuntimeKind, RuntimeAdapter>>
  conversationDirectory?: string
  messages?: ChannelMessageService
  sessions?: ConversationSessions
  contextAssembler?: ContextAssembler
  queue?: InvocationQueue
  handoffPolicy?: HandoffPolicy
  events?: DomainEventPublisher
  participationProbeTimeoutMs?: number
  now?: () => Date
}

interface TurnExecution {
  turnId: string
  channelId: string
  cancelled: boolean
  activities: Map<string, TurnActivity>
  invocationIds: Set<string>
  timedOutInvocationIds: Set<string>
}

interface RankedSpeaker {
  agent: Agent
  participant: TurnParticipant
  queueAvailable: boolean
  lastSpokenAt: string | null
}

interface HandoffWorkItem {
  handoffId: string
  fromAgentId: string
  toAgentId: string
  question: string
  round: number
  sourceInvocationId: string
}

interface ResponseOutcome {
  invocation: AgentInvocation
  response: PublicAgentResponse
}

interface InvocationCancellationBatch {
  cancelledInvocationIds: string[]
  failures: Array<{ invocationId: string; error: unknown }>
}

const duplicateCheckCancelled = Symbol('duplicate_check_cancelled')

const maxParticipationCandidates = 3
const maxInitialSpeakers = 2
const maxConversationRounds = 3
const defaultParticipationProbeTimeoutMs = 30_000
const conversationContextBudget = 4_000

export class ChannelTurnCoordinator {
  private readonly repositories: WorkspaceRepositories
  private readonly messages: ChannelMessageService
  private readonly sessions: ConversationSessions
  private readonly contextAssembler: ContextAssembler
  private readonly queue: InvocationQueue
  private readonly handoffPolicy: HandoffPolicy
  private readonly events?: DomainEventPublisher
  private readonly participationProbeTimeoutMs: number
  private readonly now: () => Date
  private readonly executions = new Map<string, TurnExecution>()
  private invocationSequence = 0

  constructor(options: ChannelTurnCoordinatorOptions) {
    this.repositories = options.repositories
    this.messages = options.messages ?? new ChannelMessageService(options.repositories)
    this.sessions = options.sessions ?? new ConversationSessionService({
      repositories: options.repositories,
      runtimes: options.runtimes ?? {},
      conversationDirectory: options.conversationDirectory ?? '',
    })
    this.contextAssembler = options.contextAssembler ?? new ContextAssembler(options.repositories)
    this.queue = options.queue ?? new AgentInvocationQueue()
    this.handoffPolicy = options.handoffPolicy ?? new HandoffPolicy()
    this.events = options.events
    this.participationProbeTimeoutMs = options.participationProbeTimeoutMs ?? defaultParticipationProbeTimeoutMs
    this.now = options.now ?? (() => new Date())
  }

  dispatch(message: Message): Promise<ConversationTurn> {
    return this.start(message).completion
  }

  start(message: Message): ChannelTurnStart {
    if (!this.repositories.getChannel(message.channelId)) throw new DomainError(`Channel ${message.channelId} does not exist.`)
    if (message.senderType !== 'human') throw new DomainError('Only persisted human messages can start a conversation turn.')
    const memberIds = new Set(this.repositories.getChannelAgentIds(message.channelId))
    const memberAgents = this.repositories.listAgents().filter((agent) => memberIds.has(agent.id))
    const route = routeMentions(message.body, memberAgents)
    if (route.unknownMentions.length > 0) throw new UnknownMentionError(route.unknownMentions)
    const targetIds = route.mode === 'all'
      ? memberAgents.map((agent) => agent.id)
      : route.targetAgentIds
    const targetAgents = targetIds
      .map((agentId) => memberAgents.find((agent) => agent.id === agentId))
      .filter((agent): agent is Agent => agent !== undefined)

    const turn = this.repositories.createConversationTurn({
      channelId: message.channelId,
      triggerMessageId: message.id,
      threadRootMessageId: message.threadRootMessageId ?? null,
      mode: route.mode,
      maxRounds: maxConversationRounds,
    })
    this.publish('conversation.turn_created', 'conversation_turn', turn.id)
    const execution: TurnExecution = {
      turnId: turn.id,
      channelId: turn.channelId,
      cancelled: false,
      activities: new Map(),
      invocationIds: new Set(),
      timedOutInvocationIds: new Set(),
    }
    this.executions.set(turn.id, execution)
    this.setActivity(execution, null, 'screening')

    const completion = this.executeTurn(execution, turn, message, targetAgents, memberIds, memberAgents)
      .finally(() => this.executions.delete(turn.id))
    void completion.catch(() => undefined)
    return { turn, completion }
  }

  private async executeTurn(
    execution: TurnExecution,
    initialTurn: ConversationTurn,
    message: Message,
    targetAgents: Agent[],
    memberIds: Set<string>,
    memberAgents: Agent[],
  ): Promise<ConversationTurn> {
    let turn = initialTurn
    try {
      if (turn.mode === 'direct') {
        return await this.runDirectTurn(execution, turn, message, targetAgents[0]!, memberIds)
      }
      if (turn.mode === 'multi_direct' || turn.mode === 'all') {
        return await this.runParallelExplicitTurn(execution, turn, message, targetAgents, memberIds)
      }
      const agents = memberAgents.filter((agent) => agent.status !== 'offline' && agent.status !== 'error')
      const candidates = matchResponsibilities(message.body, agents, maxParticipationCandidates)
      const participants = candidates.map((candidate, index) => {
        const participant = this.repositories.createTurnParticipant({
          turnId: turn.id,
          agentId: candidate.agent.id,
          source: 'responsibility',
          rank: index + 1,
          matcherScore: candidate.score,
        })
        this.publish('conversation.participant_decided', 'turn_participant', participant.id)
        return { candidate, participant }
      })

      if (execution.cancelled) return this.currentTurn(turn.id)
      turn = this.transitionTurn(turn.id, { status: 'judging' })
      const decisions = await Promise.all(participants.map(async ({ candidate, participant }) => ({
        agent: candidate.agent,
        participant: await this.probeCandidate(execution, turn, message, candidate.agent, participant),
      })))

      if (execution.cancelled) return this.currentTurn(turn.id)
      const speakers = this.orderSpeakers(turn, decisions.filter((entry) => entry.participant.decision === 'speak'))
      const selected = speakers.slice(0, maxInitialSpeakers)
      const selectedIds = new Set(selected.map((entry) => entry.agent.id))
      let speakingOrder = 1
      for (const entry of speakers) {
        const selectedForResponse = selectedIds.has(entry.agent.id)
        entry.participant = this.updateParticipant(turn.id, entry.agent.id, selectedForResponse ? {
          status: 'selected',
          speakingOrder: speakingOrder++,
        } : {
          status: 'skipped',
          reason: 'initial_speaker_limit',
        })
      }

      if (selected.length > 0) turn = this.transitionTurn(turn.id, { status: 'responding', currentRound: 1 })
      const spokenAgentIds = new Set<string>()
      const handoffProposals: Array<{ fromAgentId: string; sourceInvocationId: string; targets: PublicAgentResponse['handoffTo'] }> = []
      let publicResponseCount = 0

      for (const speaker of selected) {
        if (execution.cancelled) return this.currentTurn(turn.id)
        if (publicResponseCount > 0) {
          const duplicateDecision = await this.duplicateCheck(execution, turn, message, speaker.agent)
          if (duplicateDecision === duplicateCheckCancelled) {
            if (execution.cancelled) return this.currentTurn(turn.id)
            continue
          }
          if (execution.cancelled) return this.currentTurn(turn.id)
          if (!duplicateDecision || duplicateDecision.decision === 'silent') {
            this.updateParticipant(turn.id, speaker.agent.id, {
              status: 'skipped',
              reason: duplicateDecision ? 'duplicate_silent' : 'duplicate_check_failed',
            })
            continue
          }
        }

        const outcome = await this.respond(execution, turn, message, speaker.agent, 'response', 'human_ordinary', 1, null)
        if (!outcome) continue
        publicResponseCount += 1
        spokenAgentIds.add(speaker.agent.id)
        this.updateParticipant(turn.id, speaker.agent.id, { status: 'spoken' })
        handoffProposals.push({
          fromAgentId: speaker.agent.id,
          sourceInvocationId: outcome.invocation.id,
          targets: outcome.response.handoffTo,
        })
      }

      const worklist: HandoffWorkItem[] = []
      const edges: Array<{ fromAgentId: string; toAgentId: string }> = []
      const reservedAgentIds = new Set(spokenAgentIds)
      for (const proposal of handoffProposals) {
        this.addValidatedHandoffs(turn, proposal, memberIds, reservedAgentIds, edges, worklist)
      }
      await this.runHandoffWorklist(execution, turn, message, memberIds, spokenAgentIds, reservedAgentIds, edges, worklist)

      if (execution.cancelled) return this.currentTurn(turn.id)
      turn = this.finishTurn(turn.id)
      return turn
    } catch (error) {
      if (execution.cancelled) return this.currentTurn(turn.id)
      return this.failTurn(turn.id, error)
    }
  }

  async cancel(turnId: string): Promise<ConversationTurn> {
    const turn = this.repositories.getConversationTurn(turnId)
    if (!turn) throw new DomainError(`Conversation turn ${turnId} does not exist.`)
    if (isTerminal(turn)) return turn
    const execution = this.executions.get(turnId)
    if (execution) {
      execution.cancelled = true
      const cancellation = await this.cancelInvocations(execution, this.repositories.listAgentInvocations(turnId))
      if (cancellation.failures.length > 0 && cancellation.cancelledInvocationIds.length === 0) {
        execution.cancelled = false
        throw cancellation.failures[0]!.error
      }
      for (const failure of cancellation.failures) {
        this.markInvocationCancelled(
          execution.turnId,
          failure.invocationId,
          `cancellation_failed:${errorMessage(failure.error)}`,
        )
      }
      this.cancelParticipants(turnId)
      execution.activities.clear()
    }
    this.failAcceptedHandoffs(turnId, 'turn_cancelled')
    const cancelled = this.repositories.updateConversationTurn(turnId, {
      status: 'cancelled',
      completedAt: this.now().toISOString(),
    })
    this.publish('conversation.turn_completed', 'conversation_turn', cancelled.id)
    return cancelled
  }

  getActiveStates(channelId: string): TurnActivity[] {
    return [...this.executions.values()]
      .filter((execution) => execution.channelId === channelId)
      .flatMap((execution) => [...execution.activities.values()])
  }

  async cancelChannel(channelId: string): Promise<void> {
    const turnIds = [...this.executions.values()]
      .filter((execution) => execution.channelId === channelId)
      .map((execution) => execution.turnId)
    await Promise.all(turnIds.map((turnId) => this.cancel(turnId)))
  }

  async cancelAgentInChannel(channelId: string, agentId: string): Promise<void> {
    const executions = [...this.executions.values()].filter((execution) => execution.channelId === channelId)
    for (const execution of executions) {
      const cancellation = await this.cancelInvocations(
        execution,
        this.repositories.listAgentInvocations(execution.turnId).filter((invocation) => invocation.agentId === agentId),
      )
      if (cancellation.failures.length > 0) throw cancellation.failures[0]!.error
      const participant = this.repositories.listTurnParticipants(execution.turnId)
        .find((candidate) => candidate.agentId === agentId)
      if (participant && !isTerminalParticipant(participant)) {
        this.updateParticipant(execution.turnId, agentId, { status: 'cancelled', reason: 'agent_cancelled' })
      }
      execution.activities.delete(agentId)
    }
  }

  private async runDirectTurn(
    execution: TurnExecution,
    initialTurn: ConversationTurn,
    message: Message,
    agent: Agent,
    memberIds: Set<string>,
  ): Promise<ConversationTurn> {
    const participant = this.repositories.createTurnParticipant({
      turnId: initialTurn.id,
      agentId: agent.id,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      speakingOrder: 1,
      status: 'selected',
    })
    this.publish('conversation.participant_decided', 'turn_participant', participant.id)
    if (agent.status === 'offline' || agent.status === 'error') {
      this.updateParticipant(initialTurn.id, agent.id, { status: 'failed', reason: 'agent_unavailable' })
      return this.finishTurn(initialTurn.id)
    }

    const turn = this.transitionTurn(initialTurn.id, { status: 'responding', currentRound: 1 })
    const outcome = await this.respond(execution, turn, message, agent, 'response', 'human_direct', 1, null)
    if (!outcome) return execution.cancelled ? this.currentTurn(turn.id) : this.finishTurn(turn.id)
    this.updateParticipant(turn.id, agent.id, { status: 'spoken' })
    const spokenAgentIds = new Set([agent.id])
    const reservedAgentIds = new Set(spokenAgentIds)
    const edges: Array<{ fromAgentId: string; toAgentId: string }> = []
    const worklist: HandoffWorkItem[] = []
    this.addValidatedHandoffs(turn, {
      fromAgentId: agent.id,
      sourceInvocationId: outcome.invocation.id,
      targets: outcome.response.handoffTo,
    }, memberIds, reservedAgentIds, edges, worklist)
    await this.runHandoffWorklist(
      execution,
      turn,
      message,
      memberIds,
      spokenAgentIds,
      reservedAgentIds,
      edges,
      worklist,
    )
    return execution.cancelled ? this.currentTurn(turn.id) : this.finishTurn(turn.id)
  }

  private async runParallelExplicitTurn(
    execution: TurnExecution,
    initialTurn: ConversationTurn,
    message: Message,
    agents: Agent[],
    memberIds: Set<string>,
  ): Promise<ConversationTurn> {
    const source = initialTurn.mode === 'all' ? 'all' : 'direct'
    const availableAgents: Agent[] = []
    for (const [index, agent] of agents.entries()) {
      const unavailable = agent.status === 'offline' || agent.status === 'error'
      const participant = this.repositories.createTurnParticipant({
        turnId: initialTurn.id,
        agentId: agent.id,
        source,
        rank: index + 1,
        matcherScore: null,
        decision: 'speak',
        speakingOrder: index + 1,
        status: unavailable ? 'failed' : 'selected',
        reason: unavailable ? 'agent_unavailable' : null,
      })
      this.publish('conversation.participant_decided', 'turn_participant', participant.id)
      if (!unavailable) availableAgents.push(agent)
    }
    if (availableAgents.length === 0) return this.finishTurn(initialTurn.id)

    const turn = this.transitionTurn(initialTurn.id, { status: 'responding', currentRound: 1 })
    const settled = await Promise.allSettled(availableAgents.map((agent) => this.generateResponse(
      execution,
      turn,
      message,
      agent,
      'response',
      'human_direct',
      1,
      null,
    )))
    if (execution.cancelled) return this.currentTurn(turn.id)

    for (const [index, result] of settled.entries()) {
      const agent = availableAgents[index]!
      if (result.status === 'rejected') {
        this.updateParticipant(turn.id, agent.id, {
          status: 'failed',
          reason: `response_failed:${errorMessage(result.reason)}`,
        })
        continue
      }
      const outcome = result.value
      if (!outcome) continue
      this.persistPublicReply(turn, agent, outcome.response.reply)
      this.updateParticipant(turn.id, agent.id, { status: 'spoken' })
      this.rejectParallelHandoffs(turn, outcome, agent.id, memberIds)
    }
    return this.finishTurn(turn.id)
  }

  private async probeCandidate(
    execution: TurnExecution,
    turn: ConversationTurn,
    message: Message,
    agent: Agent,
    participant: TurnParticipant,
  ): Promise<TurnParticipant> {
    const candidateIds = this.repositories.listTurnParticipants(turn.id).map((candidate) => candidate.agentId)
    let participationInvocationId: string | undefined
    const service = new ParticipationService({
      participationProbeTimeoutMs: this.participationProbeTimeoutMs,
      invoke: (call) => this.invokeParticipation(
        execution,
        turn,
        message,
        agent,
        call,
        (invocationId) => { participationInvocationId = invocationId },
      ),
    })
    try {
      const result = await service.decide({
        candidateAgentIds: candidateIds,
        candidateResponsibilities: agent.responsibilities ?? [],
        currentMessage: message.body,
        channelSummary: this.renderContext(message),
      })
      if (execution.cancelled) return this.currentParticipant(turn.id, agent.id)
      if ('confidence' in result) {
        return this.updateParticipant(turn.id, agent.id, {
          decision: result.decision,
          confidence: result.confidence,
          proposedAngle: result.proposedAngle,
          dependsOnAgentId: result.dependsOnAgentId,
          status: result.decision === 'speak' ? 'candidate' : 'skipped',
          reason: result.reason,
        })
      }
      if (participationInvocationId) {
        execution.timedOutInvocationIds.add(participationInvocationId)
        try {
          const ownership = this.queue.cancelInvocation(participationInvocationId)
          if (ownership.state === 'running' || ownership.state === 'not_found') {
            await this.sessions.cancelInvocation(participationInvocationId)
          }
        } catch (error) {
          execution.timedOutInvocationIds.delete(participationInvocationId)
          throw error
        }
        const invocation = this.repositories.listAgentInvocations(turn.id)
          .find((candidate) => candidate.id === participationInvocationId)
        if (invocation && (invocation.status === 'queued' || invocation.status === 'running')) {
          this.repositories.updateAgentInvocation(invocation.id, {
            status: 'failed',
            completedAt: this.now().toISOString(),
            errorCode: 'timeout',
          })
          this.publish('conversation.invocation_completed', 'agent_invocation', invocation.id)
        }
        execution.activities.delete(agent.id)
      }
      return this.updateParticipant(turn.id, agent.id, {
        decision: 'silent',
        confidence: null,
        proposedAngle: null,
        dependsOnAgentId: null,
        status: 'skipped',
        reason: result.reason,
      })
    } catch (error) {
      if (execution.cancelled || isInvocationCancellation(error)) {
        return this.currentParticipant(turn.id, agent.id)
      }
      return this.updateParticipant(turn.id, agent.id, {
        decision: 'skipped',
        status: 'failed',
        reason: `participation_failed:${errorMessage(error)}`,
      })
    }
  }

  private async invokeParticipation(
    execution: TurnExecution,
    turn: ConversationTurn,
    message: Message,
    agent: Agent,
    call: RuntimeConversationCall,
    onInvocationCreated: (invocationId: string) => void,
  ): Promise<string> {
    const result = await this.runInvocation(execution, turn, message, agent, {
      kind: 'participation',
      priority: 'participation',
      round: 0,
      sourceInvocationId: null,
      expectedOutput: 'participation',
      initialMessage: call.initialMessage,
      context: `${call.prompt}\n\n${this.renderContext(message)}`,
      phase: 'judging',
      candidateAgentIds: this.repositories.listTurnParticipants(turn.id).map((participant) => participant.agentId),
    }, onInvocationCreated)
    return result.result.text
  }

  private orderSpeakers(turn: ConversationTurn, entries: Array<{ agent: Agent; participant: TurnParticipant }>): RankedSpeaker[] {
    const recentMessages = this.repositories.getBootstrap().recentMessages
    const speakers = entries.map((entry) => ({
      ...entry,
      queueAvailable: queueIsAvailable(this.queue.snapshot(entry.agent.id)) && entry.agent.status === 'idle',
      lastSpokenAt: this.repositories.getLastAgentSpokenAt(turn.channelId, entry.agent.id)
        ?? lastSpokenAtByAuthor(recentMessages, turn.channelId, entry.agent.identity),
    }))
    const byAgentId = new Map(speakers.map((speaker) => [speaker.agent.id, speaker]))
    const dependencies = new Map(speakers.map((speaker) => [
      speaker.agent.id,
      byAgentId.has(speaker.participant.dependsOnAgentId ?? '') ? speaker.participant.dependsOnAgentId : null,
    ]))
    const cycleAgentIds = dependencyCycleAgentIds(dependencies)
    for (const agentId of cycleAgentIds) {
      dependencies.set(agentId, null)
      const speaker = byAgentId.get(agentId)!
      speaker.participant = this.updateParticipant(turn.id, agentId, { reason: 'dependency_cycle_ignored' })
    }

    const remaining = new Map(byAgentId)
    const ordered: RankedSpeaker[] = []
    while (remaining.size > 0) {
      let available = [...remaining.values()].filter((speaker) => {
        const dependency = dependencies.get(speaker.agent.id)
        return dependency == null || !remaining.has(dependency)
      })
      if (available.length === 0) {
        available = [...remaining.values()]
        for (const speaker of available) {
          speaker.participant = this.updateParticipant(turn.id, speaker.agent.id, { reason: 'dependency_cycle_ignored' })
        }
      }
      available.sort(compareOrdinarySpeakers)
      const next = available[0]!
      ordered.push(next)
      remaining.delete(next.agent.id)
    }
    return ordered
  }

  private async duplicateCheck(
    execution: TurnExecution,
    turn: ConversationTurn,
    message: Message,
    agent: Agent,
  ): Promise<DuplicateDecision | null | typeof duplicateCheckCancelled> {
    const publicContext = this.renderContext(message)
    try {
      const { result } = await this.runInvocation(execution, turn, message, agent, {
        kind: 'duplicate_check',
        priority: 'duplicate_check',
        round: 1,
        sourceInvocationId: null,
        expectedOutput: 'duplicate',
        initialMessage: `Check whether your proposed contribution duplicates these persisted public replies.\n\n${publicContext}`,
        context: publicContext,
        phase: 'judging',
      })
      return isDuplicateDecision(result.parsed) ? result.parsed : null
    } catch (error) {
      if (execution.cancelled || isInvocationCancellation(error)) return duplicateCheckCancelled
      return null
    }
  }

  private async respond(
    execution: TurnExecution,
    turn: ConversationTurn,
    message: Message,
    agent: Agent,
    kind: Extract<InvocationKind, 'response' | 'handoff_response'>,
    priority: Extract<InvocationPriority, 'human_direct' | 'human_ordinary' | 'automatic_handoff'>,
    round: number,
    sourceInvocationId: string | null,
    handoffQuestion?: string,
  ): Promise<ResponseOutcome | null> {
    const outcome = await this.generateResponse(
      execution,
      turn,
      message,
      agent,
      kind,
      priority,
      round,
      sourceInvocationId,
      handoffQuestion,
    )
    if (outcome) this.persistPublicReply(turn, agent, outcome.response.reply)
    return outcome
  }

  private async generateResponse(
    execution: TurnExecution,
    turn: ConversationTurn,
    message: Message,
    agent: Agent,
    kind: Extract<InvocationKind, 'response' | 'handoff_response'>,
    priority: Extract<InvocationPriority, 'human_direct' | 'human_ordinary' | 'automatic_handoff'>,
    round: number,
    sourceInvocationId: string | null,
    handoffQuestion?: string,
  ): Promise<ResponseOutcome | null> {
    try {
      const invocationResult = await this.runInvocation(execution, turn, message, agent, {
        kind,
        priority,
        round,
        sourceInvocationId,
        expectedOutput: 'public_response',
        initialMessage: handoffQuestion ?? message.body,
        context: this.renderContext(message),
        phase: kind === 'handoff_response' ? 'handoff' : 'preparing',
      })
      if (!isPublicResponse(invocationResult.result.parsed)) throw new Error('Runtime returned no public response.')
      return { invocation: invocationResult.invocation, response: invocationResult.result.parsed }
    } catch (error) {
      if (!isInvocationCancellation(error)) {
        this.updateParticipant(turn.id, agent.id, {
          status: 'failed',
          reason: `response_failed:${errorMessage(error)}`,
        })
      }
      return null
    }
  }

  private persistPublicReply(turn: ConversationTurn, agent: Agent, reply: string): void {
    this.messages.postAgent(
      turn.channelId,
      null,
      agent.id,
      agent.identity,
      reply,
      turn.threadRootMessageId,
    )
  }

  private rejectParallelHandoffs(
    turn: ConversationTurn,
    outcome: ResponseOutcome,
    fromAgentId: string,
    memberIds: Set<string>,
  ): void {
    for (const target of outcome.response.handoffTo) {
      const handoff = this.repositories.createConversationHandoff({
        turnId: turn.id,
        sourceInvocationId: outcome.invocation.id,
        fromAgentId,
        requestedTargetAgentId: target.agentId,
        toAgentId: memberIds.has(target.agentId) ? target.agentId : null,
        question: target.question,
        round: turn.currentRound + 1,
        status: 'rejected',
        reason: 'handoff_disabled_for_parallel_mode',
      })
      this.publish('conversation.handoff_created', 'conversation_handoff', handoff.id)
    }
  }

  private addValidatedHandoffs(
    turn: ConversationTurn,
    proposal: { fromAgentId: string; sourceInvocationId: string; targets: PublicAgentResponse['handoffTo'] },
    memberIds: Set<string>,
    reservedAgentIds: Set<string>,
    edges: Array<{ fromAgentId: string; toAgentId: string }>,
    worklist: HandoffWorkItem[],
  ): void {
    if (proposal.targets.length === 0) return
    const decision = this.handoffPolicy.validate(proposal.targets, {
      turn: this.currentTurn(turn.id),
      fromAgentId: proposal.fromAgentId,
      channelMemberAgentIds: [...memberIds],
      spokenAgentIds: [...reservedAgentIds],
      handoffEdges: edges,
    })
    for (const rejected of decision.rejected) {
      const handoff = this.repositories.createConversationHandoff({
        turnId: turn.id,
        sourceInvocationId: proposal.sourceInvocationId,
        fromAgentId: proposal.fromAgentId,
        requestedTargetAgentId: rejected.agentId,
        toAgentId: memberIds.has(rejected.agentId) ? rejected.agentId : null,
        question: proposal.targets.find((target) => target.agentId === rejected.agentId)?.question ?? '',
        round: this.currentTurn(turn.id).currentRound + 1,
        status: 'rejected',
        reason: rejected.reason,
      })
      this.publish('conversation.handoff_created', 'conversation_handoff', handoff.id)
    }
    for (const accepted of decision.accepted) {
      const round = this.currentTurn(turn.id).currentRound + 1
      const handoff = this.repositories.createConversationHandoff({
        turnId: turn.id,
        sourceInvocationId: proposal.sourceInvocationId,
        fromAgentId: proposal.fromAgentId,
        requestedTargetAgentId: accepted.agentId,
        toAgentId: accepted.agentId,
        question: accepted.question,
        round,
        status: 'accepted',
      })
      this.publish('conversation.handoff_created', 'conversation_handoff', handoff.id)
      edges.push({ fromAgentId: proposal.fromAgentId, toAgentId: accepted.agentId })
      reservedAgentIds.add(accepted.agentId)
      worklist.push({
        handoffId: handoff.id,
        fromAgentId: proposal.fromAgentId,
        toAgentId: accepted.agentId,
        question: accepted.question,
        round,
        sourceInvocationId: proposal.sourceInvocationId,
      })
    }
  }

  private async runHandoffWorklist(
    execution: TurnExecution,
    initialTurn: ConversationTurn,
    message: Message,
    memberIds: Set<string>,
    spokenAgentIds: Set<string>,
    reservedAgentIds: Set<string>,
    edges: Array<{ fromAgentId: string; toAgentId: string }>,
    worklist: HandoffWorkItem[],
  ): Promise<void> {
    while (worklist.length > 0 && !execution.cancelled) {
      const item = worklist.shift()!
      const agent = this.repositories.getAgent(item.toAgentId)
      if (!agent) {
        this.finishHandoff(item.handoffId, 'failed', 'target_agent_missing')
        continue
      }
      const turn = this.transitionTurn(initialTurn.id, { status: 'handoff', currentRound: item.round })
      const existing = this.repositories.listTurnParticipants(turn.id).find((participant) => participant.agentId === agent.id)
      const participant = existing
        ? this.updateParticipant(turn.id, agent.id, {
            source: 'handoff',
            matcherScore: null,
            decision: 'speak',
            confidence: null,
            proposedAngle: null,
            dependsOnAgentId: null,
            status: 'selected',
            speakingOrder: nextSpeakingOrder(this.repositories, turn.id),
            reason: null,
          }, { failedRecoverySource: 'handoff' })
        : this.repositories.createTurnParticipant({
            turnId: turn.id,
            agentId: agent.id,
            source: 'handoff',
            rank: nextParticipantRank(this.repositories, turn.id),
            matcherScore: null,
            decision: 'speak',
            status: 'selected',
            speakingOrder: nextSpeakingOrder(this.repositories, turn.id),
          })
      if (!existing) this.publish('conversation.participant_decided', 'turn_participant', participant.id)
      const outcome = await this.respond(
        execution,
        turn,
        message,
        agent,
        'handoff_response',
        'automatic_handoff',
        item.round,
        item.sourceInvocationId,
        item.question,
      )
      if (!outcome) {
        const failedParticipant = this.repositories.listTurnParticipants(turn.id)
          .find((candidate) => candidate.agentId === agent.id)
        this.finishHandoff(
          item.handoffId,
          'failed',
          execution.cancelled ? 'turn_cancelled' : failedParticipant?.reason ?? 'response_failed',
        )
        continue
      }
      if (execution.cancelled) continue
      this.finishHandoff(item.handoffId, 'completed', null)
      spokenAgentIds.add(agent.id)
      this.updateParticipant(turn.id, agent.id, { status: 'spoken' })
      this.addValidatedHandoffs(turn, {
        fromAgentId: agent.id,
        sourceInvocationId: outcome.invocation.id,
        targets: outcome.response.handoffTo,
      }, memberIds, reservedAgentIds, edges, worklist)
    }
  }

  private async runInvocation(
    execution: TurnExecution,
    turn: ConversationTurn,
    message: Message,
    agent: Agent,
    input: {
      kind: InvocationKind
      priority: InvocationPriority
      round: number
      sourceInvocationId: string | null
      expectedOutput: 'participation' | 'public_response' | 'duplicate'
      initialMessage: string
      context: string
      phase: TurnActivity['phase']
      candidateAgentIds?: string[]
    },
    onInvocationCreated?: (invocationId: string) => void,
  ): Promise<{ invocation: AgentInvocation; result: ConversationSessionResult }> {
    const invocation = this.repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: agent.id,
      kind: input.kind,
      priority: input.priority,
      round: input.round,
      idempotencyKey: `${turn.id}:${input.round}:${input.kind}:${agent.id}`,
      sourceInvocationId: input.sourceInvocationId,
    })
    onInvocationCreated?.(invocation.id)
    execution.invocationIds.add(invocation.id)
    this.publish('conversation.invocation_queued', 'agent_invocation', invocation.id)
    const snapshot = this.queue.snapshot(agent.id)
    this.setActivity(execution, agent.id, 'queued', snapshot.queued + (snapshot.running ? 1 : 0) + 1)

    try {
      const result = await this.queue.enqueue({
        id: invocation.id,
        agentId: agent.id,
        priority: input.priority,
        sequence: this.invocationSequence++,
        run: async () => {
          if (execution.cancelled) throw new ConversationInvocationCancelledError(invocation.id)
          this.repositories.updateAgentInvocation(invocation.id, { status: 'running', startedAt: this.now().toISOString() })
          this.publish('conversation.invocation_started', 'agent_invocation', invocation.id)
          this.setActivity(execution, agent.id, input.phase)
          return this.sessions.invoke({
            channelId: turn.channelId,
            threadRootMessageId: turn.threadRootMessageId,
            currentMessageId: message.id,
            agent,
            context: input.context,
            initialMessage: input.initialMessage,
            candidateAgentIds: input.candidateAgentIds,
            conversation: {
              turnId: turn.id,
              invocationId: invocation.id,
              kind: input.kind,
              expectedOutput: input.expectedOutput,
            },
          })
        },
      })
      if (execution.cancelled) throw new ConversationInvocationCancelledError(invocation.id)
      if (execution.timedOutInvocationIds.has(invocation.id)) throw new Error('timeout')
      this.repositories.updateAgentInvocation(invocation.id, { status: 'settled', completedAt: this.now().toISOString() })
      this.publish('conversation.invocation_completed', 'agent_invocation', invocation.id)
      return { invocation, result }
    } catch (error) {
      if (!execution.timedOutInvocationIds.has(invocation.id)) {
        const current = this.repositories.listAgentInvocations(turn.id)
          .find((candidate) => candidate.id === invocation.id)
        if (current && (current.status === 'queued' || current.status === 'running')) {
          this.repositories.updateAgentInvocation(invocation.id, {
            status: execution.cancelled
              || isInvocationCancellation(error)
              ? 'cancelled'
              : 'failed',
            completedAt: this.now().toISOString(),
            errorCode: errorMessage(error),
          })
          this.publish('conversation.invocation_completed', 'agent_invocation', invocation.id)
        }
      }
      throw error
    } finally {
      execution.activities.delete(agent.id)
    }
  }

  private renderContext(message: Message): string {
    return this.contextAssembler.render(this.contextAssembler.assemble({
      channelId: message.channelId,
      threadRootMessageId: message.threadRootMessageId ?? null,
      currentMessageId: message.id,
      tokenBudget: conversationContextBudget,
    }))
  }

  private updateParticipant(
    turnId: string,
    agentId: string,
    patch: Parameters<WorkspaceRepositories['updateTurnParticipant']>[2],
    options: { failedRecoverySource?: 'handoff' } = {},
  ): TurnParticipant {
    const current = this.currentParticipant(turnId, agentId)
    if (current.status === 'cancelled'
      && patch.status !== undefined
      && patch.status !== current.status) {
      return current
    }
    const recoversFailedThroughHandoff = current.status === 'failed'
      && patch.status === 'selected'
      && patch.source === 'handoff'
      && options.failedRecoverySource === 'handoff'
    if (current.status === 'failed'
      && patch.status !== undefined
      && patch.status !== current.status
      && !recoversFailedThroughHandoff) {
      return current
    }
    const participant = this.repositories.updateTurnParticipant(turnId, agentId, patch)
    this.publish('conversation.participant_decided', 'turn_participant', participant.id)
    return participant
  }

  private currentParticipant(turnId: string, agentId: string): TurnParticipant {
    const participant = this.repositories.listTurnParticipants(turnId)
      .find((candidate) => candidate.agentId === agentId)
    if (!participant) throw new DomainError(`Turn participant ${turnId}/${agentId} does not exist.`)
    return participant
  }

  private transitionTurn(turnId: string, patch: Parameters<WorkspaceRepositories['updateConversationTurn']>[1]): ConversationTurn {
    const turn = this.repositories.updateConversationTurn(turnId, patch)
    this.publish('conversation.phase_changed', 'conversation_turn', turn.id)
    return turn
  }

  private completeTurn(turnId: string): ConversationTurn {
    this.failAcceptedHandoffs(turnId, 'turn_completed_without_handoff_terminal_state')
    const turn = this.repositories.updateConversationTurn(turnId, {
      status: 'completed',
      completedAt: this.now().toISOString(),
    })
    this.publish('conversation.turn_completed', 'conversation_turn', turn.id)
    return turn
  }

  private finishTurn(turnId: string): ConversationTurn {
    const participants = this.repositories.listTurnParticipants(turnId)
    const spokenCount = participants.filter((participant) => participant.status === 'spoken').length
    const hasFailure = participants.some((participant) => participant.status === 'failed')
      || this.repositories.listAgentInvocations(turnId).some((invocation) => invocation.status === 'failed')
    if (!hasFailure) return this.completeTurn(turnId)

    this.failAcceptedHandoffs(turnId, 'turn_completed_without_handoff_terminal_state')
    const turn = this.repositories.updateConversationTurn(turnId, {
      status: spokenCount > 0 ? 'partial' : 'failed',
      completedAt: this.now().toISOString(),
    })
    this.publish('conversation.turn_completed', 'conversation_turn', turn.id)
    return turn
  }

  private failTurn(turnId: string, error: unknown): ConversationTurn {
    for (const participant of this.repositories.listTurnParticipants(turnId)) {
      if (!isTerminalParticipant(participant)) {
        this.updateParticipant(turnId, participant.agentId, {
          status: 'failed',
          reason: `coordinator_failed:${errorMessage(error)}`,
        })
      }
    }
    this.failAcceptedHandoffs(turnId, `coordinator_failed:${errorMessage(error)}`)
    const turn = this.repositories.updateConversationTurn(turnId, {
      status: 'failed',
      completedAt: this.now().toISOString(),
    })
    this.publish('conversation.turn_completed', 'conversation_turn', turn.id)
    return turn
  }

  private finishHandoff(
    handoffId: string,
    status: Extract<ReturnType<WorkspaceRepositories['updateConversationHandoff']>['status'], 'completed' | 'failed'>,
    reason: string | null,
  ): void {
    const handoff = this.repositories.updateConversationHandoff(handoffId, { status, reason })
    this.publish(
      status === 'completed' ? 'conversation.handoff_completed' : 'conversation.handoff_failed',
      'conversation_handoff',
      handoff.id,
    )
  }

  private failAcceptedHandoffs(turnId: string, reason: string): void {
    for (const handoff of this.repositories.listConversationHandoffs(turnId)) {
      if (handoff.status === 'accepted') this.finishHandoff(handoff.id, 'failed', reason)
    }
  }

  private async cancelInvocations(
    execution: TurnExecution,
    invocations: AgentInvocation[],
  ): Promise<InvocationCancellationBatch> {
    const result: InvocationCancellationBatch = { cancelledInvocationIds: [], failures: [] }
    for (const invocation of invocations) {
      if (invocation.status !== 'queued' && invocation.status !== 'running') continue
      try {
        const ownership = this.queue.cancelInvocation(invocation.id)
        if (ownership.state === 'running' || (ownership.state === 'not_found' && invocation.status === 'running')) {
          await this.sessions.cancelInvocation(invocation.id)
        }
      } catch (error) {
        result.failures.push({ invocationId: invocation.id, error })
        continue
      }
      this.markInvocationCancelled(execution.turnId, invocation.id, 'cancelled')
      result.cancelledInvocationIds.push(invocation.id)
    }
    return result
  }

  private markInvocationCancelled(turnId: string, invocationId: string, errorCode: string): void {
    const current = this.repositories.listAgentInvocations(turnId)
      .find((candidate) => candidate.id === invocationId)
    if (!current || (current.status !== 'queued' && current.status !== 'running')) return
    this.repositories.updateAgentInvocation(invocationId, {
      status: 'cancelled',
      completedAt: this.now().toISOString(),
      errorCode,
    })
    this.publish('conversation.invocation_completed', 'agent_invocation', invocationId)
  }

  private cancelParticipants(turnId: string): void {
    for (const participant of this.repositories.listTurnParticipants(turnId)) {
      if (!isTerminalParticipant(participant)) {
        this.updateParticipant(turnId, participant.agentId, { status: 'cancelled', reason: 'turn_cancelled' })
      }
    }
  }

  private currentTurn(turnId: string): ConversationTurn {
    const turn = this.repositories.getConversationTurn(turnId)
    if (!turn) throw new DomainError(`Conversation turn ${turnId} does not exist.`)
    return turn
  }

  private setActivity(
    execution: TurnExecution,
    agentId: string | null,
    phase: TurnActivity['phase'],
    queuePosition: number | null = null,
  ): void {
    const key = agentId ?? 'turn'
    execution.activities.set(key, { turnId: execution.turnId, agentId, phase, queuePosition })
    if (agentId !== null) execution.activities.delete('turn')
  }

  private publish(type: string, entityType: string, entityId: string): void {
    const event: DomainEvent = {
      id: randomUUID(),
      type,
      occurredAt: this.now().toISOString(),
      entityType,
      entityId,
    }
    if (this.events) {
      this.events.publish(event)
      return
    }
    this.repositories.inTransaction((unitOfWork) => unitOfWork.afterCommit(event))
  }
}

function compareOrdinarySpeakers(left: RankedSpeaker, right: RankedSpeaker): number {
  return (right.participant.matcherScore ?? 0) - (left.participant.matcherScore ?? 0)
    || (right.participant.confidence ?? 0) - (left.participant.confidence ?? 0)
    || Number(right.queueAvailable) - Number(left.queueAvailable)
    || compareLastSpokenAt(left.lastSpokenAt, right.lastSpokenAt)
    || left.agent.id.localeCompare(right.agent.id)
}

function compareLastSpokenAt(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  return left.localeCompare(right)
}

function dependencyCycleAgentIds(dependencies: Map<string, string | null>): Set<string> {
  const cycleAgentIds = new Set<string>()
  for (const start of dependencies.keys()) {
    const path: string[] = []
    const pathIndexes = new Map<string, number>()
    let current: string | null = start
    while (current !== null && dependencies.has(current)) {
      const cycleStart = pathIndexes.get(current)
      if (cycleStart !== undefined) {
        for (const agentId of path.slice(cycleStart)) cycleAgentIds.add(agentId)
        break
      }
      pathIndexes.set(current, path.length)
      path.push(current)
      current = dependencies.get(current) ?? null
    }
  }
  return cycleAgentIds
}

function queueIsAvailable(snapshot: { running: boolean; queued: number }): boolean {
  return !snapshot.running && snapshot.queued === 0
}

function isDuplicateDecision(value: ConversationSessionResult['parsed']): value is DuplicateDecision {
  return value !== null && 'decision' in value && 'revisedAngle' in value
}

function isPublicResponse(value: ConversationSessionResult['parsed']): value is PublicAgentResponse {
  return value !== null && 'reply' in value && 'handoffTo' in value
}

function nextParticipantRank(repositories: WorkspaceRepositories, turnId: string): number {
  return Math.max(0, ...repositories.listTurnParticipants(turnId).map((participant) => participant.rank)) + 1
}

function nextSpeakingOrder(repositories: WorkspaceRepositories, turnId: string): number {
  return Math.max(0, ...repositories.listTurnParticipants(turnId).map((participant) => participant.speakingOrder ?? 0)) + 1
}

function lastSpokenAtByAuthor(
  messages: Message[],
  channelId: string,
  authorName: string,
): string | null {
  return messages
    .filter((message) => message.channelId === channelId
      && message.senderType === 'agent'
      && message.senderId === null
      && message.authorName === authorName
      && message.deletedAt === null)
    .reduce<string | null>((latest, message) => latest === null || message.createdAt > latest ? message.createdAt : latest, null)
}

function isTerminal(turn: ConversationTurn): boolean {
  return turn.status === 'completed' || turn.status === 'partial' || turn.status === 'cancelled' || turn.status === 'failed'
}

function isTerminalParticipant(participant: TurnParticipant): boolean {
  return participant.status === 'spoken'
    || participant.status === 'failed'
    || participant.status === 'skipped'
    || participant.status === 'cancelled'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown_error'
}

function isInvocationCancellation(
  error: unknown,
): error is AgentInvocationQueueCancelledError | ConversationInvocationCancelledError {
  return error instanceof AgentInvocationQueueCancelledError
    || error instanceof ConversationInvocationCancelledError
}
