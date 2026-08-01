import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { Agent } from '../domain/agent'
import type { TurnParticipant } from '../domain/conversation'
import type { DomainEvent } from '../domain/events'
import type { Message } from '../domain/message'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import type { WorkspaceRepositories } from '../ports/repositories'
import type {
  ConversationSessionInvocation,
  ConversationSessionResult,
} from './conversation-session-service'
import { ChannelMessageService } from './channel-message-service'
import { parsePublicResponse } from './agent-conversation-protocol'
import { ConversationInvocationCancelledError } from './conversation-session-service'
import { ChannelTurnCoordinator, compareTurnSources } from './channel-turn-coordinator'
import type { HandoffPolicy } from './handoff-policy'

describe('ChannelTurnCoordinator', () => {
  let temporaryDirectory: string | undefined
  let database: SqliteDatabase | undefined

  afterEach(async () => {
    vi.useRealTimers()
    database?.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
    database = undefined
  })

  it('orders same-Turn sources as direct, Handoff, then ordinary without changing global Queue priority', () => {
    const sources: TurnParticipant['source'][] = ['responsibility', 'handoff', 'direct']
    expect(sources.sort(compareTurnSources))
      .toEqual(['direct', 'handoff', 'responsibility'])
  })

  it('persists at most three responsibility candidates before probing all three in parallel', async () => {
    const fixture = await createFixture()
    const agents = Array.from({ length: 4 }, (_, index) => fixture.createAgent(`Agent ${index}`, ['shared topic']))
    const gates = new Map(agents.map((agent) => [agent.id, deferred<ConversationSessionResult>()]))
    fixture.sessions.handle = (input) => gates.get(input.agent.id)!.promise
    const message = fixture.postHuman('shared topic')

    const dispatch = fixture.coordinator.dispatch(message)
    await waitFor(() => fixture.sessions.calls.length === 3)

    const turn = fixture.turnFor(message)
    expect(fixture.repositories.listTurnParticipants(turn.id)).toHaveLength(3)
    expect(fixture.sessions.calls.every((call) => call.conversation?.kind === 'participation')).toBe(true)

    for (const gate of gates.values()) gate.resolve(participation('silent', 0))
    await expect(dispatch).resolves.toMatchObject({ status: 'completed' })
  })

  it('routes one direct mention without participation and does not wake an ordinary match', async () => {
    const fixture = await createFixture()
    const target = fixture.createAgent('Target', ['unrelated specialty'])
    fixture.createAgent('Ordinary', ['direct request'])
    fixture.sessions.handle = async (input) => publicReply('direct answer')

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@Target direct request'))

    expect(turn).toMatchObject({ mode: 'direct', status: 'completed', currentRound: 1 })
    expect(fixture.sessions.calls).toHaveLength(1)
    expect(fixture.sessions.calls[0]).toMatchObject({
      agent: { id: target.id },
      conversation: { kind: 'response' },
    })
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual([
      expect.objectContaining({ agentId: target.id, source: 'direct', status: 'spoken' }),
    ])
  })

  it('uses the timeout union shape guard and completes when no candidate elects to speak', async () => {
    const fixture = await createFixture({ participationProbeTimeoutMs: 5 })
    const slow = fixture.createAgent('Slow', ['timeout topic'])
    const quiet = fixture.createAgent('Quiet', ['timeout topic'])
    fixture.sessions.handle = (input) => input.agent.id === slow.id
      ? new Promise<ConversationSessionResult>(() => undefined)
      : Promise.resolve(participation('silent', 0.1))
    const message = fixture.postHuman('timeout topic')

    const turn = await fixture.coordinator.dispatch(message)

    expect(turn.status).toBe('completed')
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: slow.id, decision: 'silent', confidence: null, status: 'skipped', reason: 'timeout' }),
      expect.objectContaining({ agentId: quiet.id, decision: 'silent', confidence: 0.1, status: 'skipped' }),
    ]))
    expect(fixture.repositories.listAgentInvocations(turn.id).find((invocation) => invocation.agentId === slow.id))
      .toMatchObject({ status: 'failed', errorCode: 'timeout' })
  })

  it('orders speakers by dependencies and deterministic ordinary-candidate keys', async () => {
    const fixture = await createFixture()
    const dependency = fixture.createAgent('Dependency', ['ordering topic'])
    const dependent = fixture.createAgent('Dependent', ['ordering topic'])
    const available = fixture.createAgent('Available', ['ordering topic'])
    const candidates = [dependency, dependent, available]
    const selectedCandidates = candidates.slice().sort((left, right) => left.id.localeCompare(right.id))
    const [firstById, secondById, thirdById] = selectedCandidates
    fixture.queueAvailability.set(firstById.id, false)
    fixture.queueAvailability.set(secondById.id, true)
    fixture.queueAvailability.set(thirdById.id, true)
    fixture.setLastSpokenAt(secondById.id, '2026-07-31T09:00:00.000Z')
    fixture.setLastSpokenAt(thirdById.id, '2026-07-31T08:00:00.000Z')
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') {
        if (input.agent.id === firstById.id) return participation('speak', 1, secondById.id)
        return participation('speak', 0.5)
      }
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      return publicReply(`${input.agent.identity} reply`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('ordering topic'))
    const selected = fixture.repositories.listTurnParticipants(turn.id)
      .filter((participant) => participant.speakingOrder !== null)
      .sort((left, right) => left.speakingOrder! - right.speakingOrder!)

    expect(selected.map((participant) => participant.agentId)).toEqual([thirdById.id, secondById.id])
    expect(selected.map((participant) => participant.speakingOrder)).toEqual([1, 2])
  })

  it('uses persisted public replies as a recency fallback on later turns', async () => {
    const fixture = await createFixture()
    const agents = [
      fixture.createAgent('Alpha', ['通用回复']),
      fixture.createAgent('Beta', ['通用回复']),
      fixture.createAgent('Gamma', ['通用回复']),
    ]
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.8)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      return publicReply(`${input.agent.identity} answer`)
    }

    const firstTurn = await fixture.coordinator.dispatch(fixture.postHuman('first general question'))
    const firstSpeakers = new Set(fixture.repositories.listTurnParticipants(firstTurn.id)
      .filter((participant) => participant.status === 'spoken')
      .map((participant) => participant.agentId))
    const neverSpokeFirst = agents.find((agent) => !firstSpeakers.has(agent.id))!
    const secondTurn = await fixture.coordinator.dispatch(fixture.postHuman('second general question'))
    const secondSpeakers = fixture.repositories.listTurnParticipants(secondTurn.id)
      .filter((participant) => participant.status === 'spoken')
      .map((participant) => participant.agentId)
    expect(secondSpeakers).toContain(neverSpokeFirst.id)
  })

  it('ignores dependency edges inside a cycle, records the reason, and does not stall the turn', async () => {
    const fixture = await createFixture()
    const left = fixture.createAgent('Left', ['cycle topic'])
    const right = fixture.createAgent('Right', ['cycle topic'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') {
        return participation('speak', 0.8, input.agent.id === left.id ? right.id : left.id)
      }
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      return publicReply(`${input.agent.identity} reply`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('cycle topic'))

    expect(turn.status).toBe('completed')
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: left.id, reason: 'dependency_cycle_ignored', status: 'spoken' }),
      expect.objectContaining({ agentId: right.id, reason: 'dependency_cycle_ignored', status: 'spoken' }),
    ]))
  })

  it('persists the first public reply before the later speaker duplicate check and emits no silent placeholder', async () => {
    const fixture = await createFixture()
    const first = fixture.createAgent('First', ['exact duplicate topic'])
    const second = fixture.createAgent('Second', ['通用回复'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.9)
      if (input.conversation?.kind === 'duplicate_check') {
        expect(fixture.agentMessages()).toEqual([
          expect.objectContaining({ authorName: first.identity, body: 'first persisted answer' }),
        ])
        expect(input.initialMessage).toContain('first persisted answer')
        return duplicate('silent')
      }
      return publicReply('first persisted answer')
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('exact duplicate topic'))

    expect(fixture.agentMessages()).toHaveLength(1)
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: first.id, status: 'spoken' }),
      expect.objectContaining({ agentId: second.id, status: 'skipped', reason: 'duplicate_silent' }),
    ]))
  })

  it('completes with persisted failure reasons when every selected response fails', async () => {
    const fixture = await createFixture()
    fixture.createAgent('One', ['failure topic'])
    fixture.createAgent('Two', ['failure topic'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.8)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      throw new Error(`response failed for ${input.agent.identity}`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('failure topic'))

    expect(turn.status).toBe('completed')
    expect(fixture.agentMessages()).toEqual([])
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('response_failed') }),
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('response_failed') }),
    ]))
  })

  it('starts an accepted handoff only after its source reply is persisted and carries the Thread root', async () => {
    const fixture = await createFixture()
    const source = fixture.createAgent('Source', ['handoff topic'])
    const target = fixture.createAgent('Target', ['unrelated specialty'])
    const root = fixture.postHuman('Thread root')
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.9)
      if (input.conversation?.kind === 'response') {
        return publicReply('source answer', [{ agentId: target.id, question: 'Please verify.' }])
      }
      if (input.conversation?.kind === 'handoff_response') {
        expect(fixture.agentMessages()).toEqual([
          expect.objectContaining({ authorName: source.identity, body: 'source answer', threadRootMessageId: root.id }),
        ])
        return publicReply('target answer')
      }
      throw new Error(`Unexpected invocation ${input.conversation?.kind}`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('handoff topic', root.id))

    expect(turn).toMatchObject({ status: 'completed', currentRound: 2 })
    expect(fixture.agentMessages()).toEqual([
      expect.objectContaining({ senderId: source.id, authorName: source.identity, body: 'source answer', threadRootMessageId: root.id }),
      expect.objectContaining({ senderId: target.id, authorName: target.identity, body: 'target answer', threadRootMessageId: root.id }),
    ])
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({
        fromAgentId: source.id,
        toAgentId: target.id,
        question: 'Please verify.',
        round: 2,
        status: 'completed',
      }),
    ])
  })

  it('marks an accepted Handoff failed when its target response fails and leaves no accepted work', async () => {
    const fixture = await createFixture()
    const source = fixture.createAgent('Source', ['handoff failure topic'])
    const target = fixture.createAgent('Target', ['unrelated'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.9)
      if (input.conversation?.kind === 'response') {
        return publicReply('source persisted', [{ agentId: target.id, question: 'Please fail.' }])
      }
      throw new Error('target runtime failed')
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('handoff failure topic'))

    expect(turn.status).toBe('completed')
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({
        toAgentId: target.id,
        status: 'failed',
        reason: expect.stringContaining('response_failed'),
      }),
    ])
    expect(fixture.repositories.listConversationHandoffs(turn.id).some((handoff) => handoff.status === 'accepted')).toBe(false)
  })

  it('uses sender IDs for recency after an Agent rename and duplicate historical display name', async () => {
    const fixture = await createFixture()
    const renamed = fixture.createAgent('Original Name', ['identity topic'])
    const reusedName = fixture.createAgent('Other Name', ['identity topic'])
    const neverSpoke = fixture.createAgent('Never Spoke', ['identity topic'])
    fixture.setLastSpokenAt(renamed.id, '2026-07-31T09:00:00.000Z')
    database!.database.prepare('UPDATE agents SET identity = ? WHERE id = ?').run('Renamed Agent', renamed.id)
    database!.database.prepare('UPDATE agents SET identity = ? WHERE id = ?').run('Original Name', reusedName.id)
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.8)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      return publicReply(`${input.agent.id} answer`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('identity topic'))
    const spoken = fixture.repositories.listTurnParticipants(turn.id)
      .filter((participant) => participant.status === 'spoken')
      .map((participant) => participant.agentId)

    expect(spoken).toContain(reusedName.id)
    expect(spoken).toContain(neverSpoke.id)
    expect(spoken).not.toContain(renamed.id)
  })

  it('uses exact sender recency after the attributed reply falls outside the 50-message bootstrap window', async () => {
    const fixture = await createFixture()
    const agents = [
      fixture.createAgent('Candidate A', ['window topic']),
      fixture.createAgent('Candidate B', ['window topic']),
      fixture.createAgent('Candidate C', ['window topic']),
    ]
    const oldestById = [...agents].sort((left, right) => left.id.localeCompare(right.id))[0]!
    fixture.setLastSpokenAt(oldestById.id, '2026-07-31T09:00:00.000Z')
    for (let index = 0; index < 55; index += 1) fixture.postHuman(`filler ${index}`)
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.8)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      return publicReply(`${input.agent.id} answer`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('window topic'))
    const spoken = fixture.repositories.listTurnParticipants(turn.id)
      .filter((participant) => participant.status === 'spoken')
      .map((participant) => participant.agentId)

    expect(spoken).not.toContain(oldestById.id)
  })

  it('publishes a valid reply and persists Policy rejections for an empty question and third target', async () => {
    const fixture = await createFixture()
    const source = fixture.createAgent('Source', ['unrelated'])
    const target = fixture.createAgent('Target', ['unrelated'])
    fixture.sessions.handle = async () => {
      const raw = JSON.stringify({
        reply: 'reply survives policy rejection',
        handoffTo: [
          { agentId: target.id, question: '' },
          { agentId: source.id, question: 'self target' },
          { agentId: 'raw-missing-agent', question: 'third target' },
        ],
      })
      const parsed = parsePublicResponse(raw)
      return { text: parsed.reply, parsed }
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@Source route this'))

    expect(fixture.agentMessages()).toEqual([
      expect.objectContaining({ body: 'reply survives policy rejection' }),
    ])
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({
        requestedTargetAgentId: target.id,
        toAgentId: target.id,
        status: 'rejected',
        reason: 'question_required',
      }),
      expect.objectContaining({ status: 'rejected', reason: 'self_handoff' }),
      expect.objectContaining({
        requestedTargetAgentId: 'raw-missing-agent',
        toAgentId: null,
        status: 'rejected',
        reason: 'max_targets_exceeded',
      }),
    ])
  })

  it('publishes coordinator events only after the referenced state is persisted', async () => {
    const observed: string[] = []
    const fixture = await createFixture({
      onCoordinatorEvent: (event, repositories) => {
        if (!event.type.startsWith('conversation.')) return
        if (event.entityType === 'conversation_turn') {
          expect(repositories.getConversationTurn(event.entityId)).toBeDefined()
        }
        observed.push(event.type)
      },
    })
    fixture.createAgent('Quiet', ['event topic'])
    fixture.sessions.handle = async () => participation('silent', 0)

    await fixture.coordinator.dispatch(fixture.postHuman('event topic'))

    expect(observed[0]).toBe('conversation.turn_created')
    expect(observed.at(-1)).toBe('conversation.turn_completed')
  })

  it('persists a failed Turn when an unexpected background policy error occurs', async () => {
    const fixture = await createFixture({
      handoffPolicy: {
        validate: () => { throw new Error('policy infrastructure failed') },
      } as HandoffPolicy,
    })
    const source = fixture.createAgent('Source', ['unrelated'])
    const target = fixture.createAgent('Target', ['unrelated'])
    fixture.sessions.handle = async () => publicReply('persisted before policy', [
      { agentId: target.id, question: 'Review.' },
    ])
    const message = fixture.postHuman('@Source trigger policy')

    const started = fixture.coordinator.start(message)

    expect(started.turn.status).toBe('screening')
    await expect(started.completion).resolves.toMatchObject({ status: 'failed' })
    expect(fixture.repositories.getConversationTurn(started.turn.id)).toMatchObject({ status: 'failed' })
    expect(fixture.agentMessages()).toEqual([expect.objectContaining({ senderId: source.id })])
  })

  it('cancels a queued Invocation without affecting another Turn for the same Agent or running it later', async () => {
    const fixture = await createFixture({ realQueue: true })
    const agent = fixture.createAgent('Solo', ['unrelated'])
    const firstGate = deferred<ConversationSessionResult>()
    fixture.sessions.handle = async (input) => input.conversation?.turnId === fixture.turnFor(firstMessage).id
      ? firstGate.promise
      : publicReply('late reply must not run')
    const firstMessage = fixture.postHuman('@Solo first')
    const firstCompletion = fixture.coordinator.dispatch(firstMessage)
    await waitFor(() => fixture.sessions.calls.length === 1)
    const secondMessage = fixture.postHuman('@Solo second')
    const secondCompletion = fixture.coordinator.dispatch(secondMessage)
    await waitFor(() => fixture.repositories.listAgentInvocations(fixture.turnFor(secondMessage).id).length === 1)
    const secondTurn = fixture.turnFor(secondMessage)

    await fixture.coordinator.cancel(secondTurn.id)
    await expect(secondCompletion).resolves.toMatchObject({ status: 'cancelled' })

    expect(fixture.sessions.cancelledInvocationIds).toEqual([])
    expect(fixture.sessions.coarseCancellationCalls).toEqual([])
    expect(fixture.repositories.listAgentInvocations(secondTurn.id)).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ])
    expect(fixture.repositories.listTurnParticipants(secondTurn.id)).toEqual([
      expect.objectContaining({ agentId: agent.id, status: 'cancelled' }),
    ])
    firstGate.resolve(publicReply('first survives'))
    await expect(firstCompletion).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.sessions.calls).toHaveLength(1)
  })

  it('keeps a running Turn active when exact Runtime cancellation fails, then retries without apology', async () => {
    const fixture = await createFixture({ realQueue: true })
    fixture.createAgent('Solo', ['unrelated'])
    const gate = deferred<ConversationSessionResult>()
    fixture.sessions.handle = () => gate.promise
    const message = fixture.postHuman('@Solo cancel me')
    const completion = fixture.coordinator.dispatch(message)
    await waitFor(() => fixture.sessions.calls.length === 1)
    const turn = fixture.turnFor(message)
    const invocationId = fixture.repositories.listAgentInvocations(turn.id)[0]!.id
    fixture.sessions.cancellationFailure = new Error('runtime cancellation failed')

    await expect(fixture.coordinator.cancel(turn.id)).rejects.toThrow('runtime cancellation failed')

    expect(fixture.repositories.getConversationTurn(turn.id)?.status).toBe('responding')
    expect(fixture.coordinator.getActiveStates(fixture.channel.id)).not.toEqual([])
    expect(fixture.agentMessages()).toEqual([])

    fixture.sessions.cancellationFailure = undefined
    fixture.sessions.onCancelInvocation = (cancelledId) => {
      if (cancelledId === invocationId) gate.reject(new ConversationInvocationCancelledError(cancelledId))
    }
    await fixture.coordinator.cancel(turn.id)
    await expect(completion).resolves.toMatchObject({ status: 'cancelled' })
    expect(fixture.sessions.cancelledInvocationIds).toEqual([invocationId])
    expect(fixture.sessions.coarseCancellationCalls).toEqual([])
    expect(fixture.repositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listTurnParticipants(turn.id)[0]).toMatchObject({ status: 'cancelled' })
  })

  async function createFixture(options: {
    participationProbeTimeoutMs?: number
    onCoordinatorEvent?: (event: DomainEvent, repositories: WorkspaceRepositories) => void
    realQueue?: boolean
    handoffPolicy?: HandoffPolicy
  } = {}) {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-turn-'))
    database = createSqliteDatabase(path.join(temporaryDirectory, 'sinapsis.sqlite'))
    let repositories!: SqliteRepositories
    const publisher = new RecordingPublisher((event) => options.onCoordinatorEvent?.(event, repositories))
    repositories = new SqliteRepositories(database, publisher)
    const workspace = repositories.createWorkspace({ name: 'Sinapsis' })
    repositories.createRepository({
      workspaceId: workspace.id,
      name: 'demo',
      path: '/workspace/demo',
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ name: 'general' })
    const messages = new ChannelMessageService(repositories)
    const sessions = new ScriptedSessions()
    const queueAvailability = new Map<string, boolean>()
    const coordinator = new ChannelTurnCoordinator({
      repositories,
      messages,
      sessions,
      participationProbeTimeoutMs: options.participationProbeTimeoutMs ?? 50,
      handoffPolicy: options.handoffPolicy,
      ...(options.realQueue ? {} : { queue: {
        enqueue: (invocation) => invocation.run(),
        cancel: () => undefined,
        cancelInvocation: (invocationId) => ({ invocationId, state: 'not_found' as const }),
        snapshot: (agentId) => ({ running: queueAvailability.get(agentId) === false, queued: 0 }),
      } }),
    })
    const createAgent = (identity: string, responsibilities: string[]): Agent => {
      const agent = repositories.createAgent({
        identity,
        mentionName: identity.toLocaleLowerCase().replaceAll(' ', '-'),
        runtime: 'opencode',
        capabilityTags: [],
        responsibilities,
        maxConcurrentTasks: 1,
        command: 'fake-runtime',
        args: [],
        model: '',
        env: {},
      })
      repositories.addChannelAgent(channel.id, agent.id, new Date())
      repositories.setAgentStatus(agent.id, 'idle', new Date())
      return agent
    }
    const postHuman = (body: string, threadRootMessageId?: string | null) => messages.postHuman(channel.id, body, null, threadRootMessageId)
    const allMessages = () => repositories.getBootstrap().recentMessages.filter((message) => message.channelId === channel.id)
    const agentMessages = () => allMessages().filter((message) => message.senderType === 'agent')
    const turnFor = (message: Message) => {
      const row = database!.database.prepare('SELECT id FROM conversation_turns WHERE trigger_message_id = ?').get(message.id) as { id: string }
      return repositories.getConversationTurn(row.id)!
    }
    const setLastSpokenAt = (agentId: string, createdAt: string) => {
      const agent = repositories.getAgent(agentId)!
      const message = messages.postAgent(channel.id, null, agent.id, agent.identity, 'earlier reply')
      database!.database.prepare('UPDATE messages SET sender_id = ?, created_at = ?, updated_at = ? WHERE id = ?')
        .run(agentId, createdAt, createdAt, message.id)
    }

    return {
      repositories,
      channel,
      sessions,
      coordinator,
      queueAvailability,
      createAgent,
      postHuman,
      agentMessages,
      turnFor,
      setLastSpokenAt,
    }
  }
})

class ScriptedSessions {
  calls: ConversationSessionInvocation[] = []
  cancelledInvocationIds: string[] = []
  coarseCancellationCalls: string[] = []
  cancellationFailure: Error | undefined
  onCancelInvocation: ((invocationId: string) => void) | undefined
  handle: (input: ConversationSessionInvocation) => Promise<ConversationSessionResult> = async () => participation('silent', 0)

  invoke(input: ConversationSessionInvocation): Promise<ConversationSessionResult> {
    this.calls.push(input)
    return this.handle(input)
  }

  cancelChannel(): Promise<{ cancelledSessionKeys: string[] }> {
    this.coarseCancellationCalls.push('channel')
    return Promise.resolve({ cancelledSessionKeys: [] })
  }

  cancelAgentInChannel(_channelId: string, agentId: string): Promise<{ cancelledSessionKeys: string[] }> {
    this.coarseCancellationCalls.push(`agent:${agentId}`)
    return Promise.resolve({ cancelledSessionKeys: [] })
  }

  cancelInvocation(invocationId: string): Promise<{ invocationId: string; cancelledSessionKeys: string[] }> {
    if (this.cancellationFailure) return Promise.reject(this.cancellationFailure)
    this.cancelledInvocationIds.push(invocationId)
    this.onCancelInvocation?.(invocationId)
    return Promise.resolve({ invocationId, cancelledSessionKeys: [] })
  }
}

class RecordingPublisher implements DomainEventPublisher {
  constructor(private readonly onEvent: (event: DomainEvent) => void = () => undefined) {}

  publish(event: DomainEvent): void {
    this.onEvent(event)
  }
}

function participation(decision: 'speak' | 'silent', confidence: number, dependsOnAgentId: string | null = null): ConversationSessionResult {
  const parsed = {
    decision,
    confidence,
    reason: decision === 'speak' ? 'relevant' : 'not relevant',
    proposedAngle: decision === 'speak' ? 'contribute' : '',
    dependsOnAgentId,
  } as const
  return { text: JSON.stringify(parsed), parsed }
}

function duplicate(decision: 'speak' | 'silent'): ConversationSessionResult {
  return {
    text: JSON.stringify({ decision, reason: decision === 'speak' ? 'adds value' : 'covered', revisedAngle: null }),
    parsed: { decision, reason: decision === 'speak' ? 'adds value' : 'covered', revisedAngle: null },
  }
}

function publicReply(reply: string, handoffTo: Array<{ agentId: string; question: string }> = []): ConversationSessionResult {
  return { text: reply, parsed: { reply, handoffTo } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !predicate(); index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(predicate()).toBe(true)
}
