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
import { ChannelTurnCoordinator } from './channel-turn-coordinator'
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

  it('runs multiple explicit mentions in parallel and persists replies in mention order', async () => {
    const fixture = await createFixture()
    const alpha = fixture.createAgent('Alpha', ['shared topic'])
    const beta = fixture.createAgent('Beta', ['shared topic'])
    const unmentioned = fixture.createAgent('Unmentioned', ['shared topic'])
    const gates = new Map([
      [alpha.id, deferred<ConversationSessionResult>()],
      [beta.id, deferred<ConversationSessionResult>()],
    ])
    fixture.sessions.handle = (input) => gates.get(input.agent.id)!.promise

    const dispatch = fixture.coordinator.dispatch(fixture.postHuman('@Beta @Alpha shared topic'))
    await waitFor(() => fixture.sessions.calls.length === 2)

    expect(fixture.sessions.calls.map((call) => call.agent.id)).toEqual(expect.arrayContaining([alpha.id, beta.id]))
    expect(fixture.sessions.calls.some((call) => call.agent.id === unmentioned.id)).toBe(false)
    expect(fixture.sessions.calls.every((call) => call.conversation?.kind === 'response')).toBe(true)
    gates.get(alpha.id)!.resolve(publicReply('alpha answer', [{ agentId: unmentioned.id, question: 'continue?' }]))
    await Promise.resolve()
    expect(fixture.agentMessages()).toEqual([])
    gates.get(beta.id)!.resolve(publicReply('beta answer', [{ agentId: unmentioned.id, question: 'beta continue?' }]))

    const turn = await dispatch
    expect(turn).toMatchObject({ mode: 'multi_direct', status: 'completed', currentRound: 1 })
    expect(fixture.agentMessages().map((message) => message.senderId)).toEqual([beta.id, alpha.id])
    expect(fixture.repositories.listTurnParticipants(turn.id).map((participant) => participant.agentId))
      .toEqual([beta.id, alpha.id])
    expect(fixture.repositories.listAgentInvocations(turn.id).map((invocation) => invocation.agentId))
      .toEqual([beta.id, alpha.id])
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({
        fromAgentId: beta.id,
        requestedTargetAgentId: unmentioned.id,
        question: 'beta continue?',
        status: 'rejected',
        reason: 'handoff_disabled_for_parallel_mode',
      }),
      expect.objectContaining({
        fromAgentId: alpha.id,
        requestedTargetAgentId: unmentioned.id,
        question: 'continue?',
        status: 'rejected',
        reason: 'handoff_disabled_for_parallel_mode',
      }),
    ])
    expect(fixture.sessions.calls.some((call) => call.conversation?.kind === 'handoff_response')).toBe(false)
  })

  it('marks @all partial when one member fails while preserving successful replies', async () => {
    const fixture = await createFixture()
    const agents = Array.from({ length: 4 }, (_, index) => fixture.createAgent(`Agent ${index}`, ['all topic']))
    const failing = agents[1]!
    fixture.sessions.handle = async (input) => {
      if (input.agent.id === failing.id) throw new Error('runtime unavailable')
      return publicReply(`${input.agent.identity} answer`, [{ agentId: failing.id, question: 'continue?' }])
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@all all topic'))

    expect(turn).toMatchObject({ mode: 'all', status: 'partial', currentRound: 1 })
    expect(fixture.sessions.calls).toHaveLength(4)
    expect(fixture.sessions.calls.every((call) => call.conversation?.kind === 'response')).toBe(true)
    expect(fixture.agentMessages().map((message) => message.senderId)).toEqual(
      fixture.repositories.listAgents().filter((agent) => agent.id !== failing.id).map((agent) => agent.id),
    )
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: failing.id, status: 'failed', reason: 'response_failed:runtime unavailable' }),
    ]))
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'rejected', reason: 'handoff_disabled_for_parallel_mode' }),
    ]))
    expect(fixture.sessions.calls.some((call) => call.conversation?.kind === 'handoff_response')).toBe(false)
  })

  it('marks a parallel explicit Turn failed when every Runtime fails', async () => {
    const fixture = await createFixture()
    const alpha = fixture.createAgent('Alpha', [])
    const beta = fixture.createAgent('Beta', [])
    fixture.sessions.handle = async (input) => {
      throw new Error(`${input.agent.identity} unavailable`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@Alpha @Beta answer'))

    expect(turn).toMatchObject({ mode: 'multi_direct', status: 'failed', currentRound: 1 })
    expect(fixture.agentMessages()).toEqual([])
    expect(fixture.repositories.listTurnParticipants(turn.id)).toEqual([
      expect.objectContaining({ agentId: alpha.id, status: 'failed' }),
      expect.objectContaining({ agentId: beta.id, status: 'failed' }),
    ])
  })

  it('marks a direct Turn failed when its only public response fails', async () => {
    const fixture = await createFixture()
    fixture.createAgent('Solo', [])
    fixture.sessions.handle = async () => { throw new Error('runtime unavailable') }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@Solo answer'))

    expect(turn).toMatchObject({ mode: 'direct', status: 'failed', currentRound: 1 })
    expect(fixture.agentMessages()).toEqual([])
  })

  it('marks an ordinary Turn partial when one public reply succeeds and another fails', async () => {
    const fixture = await createFixture()
    fixture.createAgent('Alpha', ['partial topic'])
    fixture.createAgent('Beta', ['partial topic'])
    let responseCount = 0
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 1)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      responseCount += 1
      if (responseCount === 2) throw new Error('second response failed')
      return publicReply('first response')
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('partial topic'))

    expect(turn).toMatchObject({ mode: 'ordinary', status: 'partial', currentRound: 1 })
    expect(fixture.agentMessages()).toHaveLength(1)
  })

  it('keeps a partially failed cancellation retryable and only retries the still-running Invocation', async () => {
    const fixture = await createFixture({ realQueue: true })
    fixture.createAgent('Alpha', [])
    fixture.createAgent('Beta', [])
    const gates = new Map<string, ReturnType<typeof deferred<ConversationSessionResult>>>()
    fixture.sessions.handle = (input) => {
      const gate = deferred<ConversationSessionResult>()
      gates.set(input.agent.id, gate)
      return gate.promise
    }
    const started = fixture.coordinator.start(fixture.postHuman('@Alpha @Beta cancel both'))
    await waitFor(() => fixture.sessions.calls.length === 2)
    const invocations = fixture.repositories.listAgentInvocations(started.turn.id)
    const first = invocations[0]!
    const second = invocations[1]!
    fixture.sessions.cancellationFailures.set(second.id, new Error('second runtime cancellation failed'))
    fixture.sessions.onCancelInvocation = (invocationId) => gates.get(
      invocations.find((invocation) => invocation.id === invocationId)!.agentId,
    )!.reject(new ConversationInvocationCancelledError(invocationId))

    await expect(fixture.coordinator.cancel(started.turn.id)).rejects.toThrow('second runtime cancellation failed')

    expect(fixture.repositories.getConversationTurn(started.turn.id)).toMatchObject({ status: 'responding', completedAt: null })
    expect(fixture.repositories.listAgentInvocations(started.turn.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'cancelled' }),
      expect.objectContaining({ id: second.id, status: 'running', completedAt: null }),
    ])
    expect(fixture.repositories.listTurnParticipants(started.turn.id)).toEqual([
      expect.objectContaining({ agentId: first.agentId, status: 'cancelled' }),
      expect.objectContaining({ agentId: second.agentId, status: 'selected' }),
    ])
    expect(fixture.agentMessages()).toEqual([])

    fixture.sessions.cancellationFailures.delete(second.id)
    await expect(fixture.coordinator.cancel(started.turn.id)).resolves.toMatchObject({ status: 'cancelled' })
    await expect(started.completion).resolves.toMatchObject({ status: 'cancelled' })

    expect(fixture.sessions.cancelledInvocationIds).toEqual([first.id, second.id])
    expect(fixture.sessions.cancellationAttempts).toEqual([first.id, second.id, second.id])
    expect(fixture.repositories.listAgentInvocations(started.turn.id))
      .toEqual(invocations.map((invocation) => expect.objectContaining({ id: invocation.id, status: 'cancelled' })))
    expect(fixture.repositories.listTurnParticipants(started.turn.id)
      .every((participant) => participant.status === 'cancelled')).toBe(true)

    fixture.sessions.handle = async () => publicReply('lane resumed')
    const resumed = fixture.coordinator.start(fixture.postHuman('@Beta continue after cancellation'))
    await expect(resumed.completion).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.agentMessages().map((message) => message.body)).toEqual(['lane resumed'])
  })

  it('keeps the Turn retryable when cancellation fails but fences that Runtime natural completion', async () => {
    const fixture = await createFixture({ realQueue: true })
    fixture.createAgent('Alpha', [])
    fixture.createAgent('Beta', [])
    const gates = new Map<string, ReturnType<typeof deferred<ConversationSessionResult>>>()
    fixture.sessions.handle = (input) => {
      const gate = deferred<ConversationSessionResult>()
      gates.set(input.agent.id, gate)
      return gate.promise
    }
    const started = fixture.coordinator.start(fixture.postHuman('@Alpha @Beta cancel one'))
    await waitFor(() => fixture.sessions.calls.length === 2)
    const invocations = fixture.repositories.listAgentInvocations(started.turn.id)
    const first = invocations[0]!
    const second = invocations[1]!
    fixture.sessions.cancellationFailures.set(second.id, new Error('second runtime cancellation failed'))
    fixture.sessions.onCancelInvocation = (invocationId) => {
      if (invocationId === first.id) gates.get(first.agentId)!.reject(new ConversationInvocationCancelledError(invocationId))
    }

    await expect(fixture.coordinator.cancel(started.turn.id)).rejects.toThrow('second runtime cancellation failed')
    gates.get(second.agentId)!.resolve(publicReply('runtime completed naturally'))
    await expect(started.completion).resolves.toMatchObject({ status: 'responding' })

    expect(fixture.repositories.listAgentInvocations(started.turn.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'cancelled' }),
      expect.objectContaining({ id: second.id, status: 'cancelled' }),
    ])
    expect(fixture.repositories.listTurnParticipants(started.turn.id)).toEqual([
      expect.objectContaining({ agentId: first.agentId, status: 'cancelled' }),
      expect.objectContaining({ agentId: second.agentId, status: 'selected' }),
    ])
    expect(fixture.agentMessages()).toEqual([])

    fixture.sessions.cancellationFailures.delete(second.id)
    await expect(fixture.coordinator.cancel(started.turn.id)).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('allows a direct reply to hand off to another channel member', async () => {
    const fixture = await createFixture()
    const source = fixture.createAgent('Source', [])
    const target = fixture.createAgent('Target', [])
    fixture.sessions.handle = async (input) => input.conversation?.kind === 'handoff_response'
      ? publicReply('target answer')
      : publicReply('source answer', [{ agentId: target.id, question: 'Please continue.' }])

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@Source begin'))

    expect(turn).toMatchObject({ mode: 'direct', status: 'completed', currentRound: 2 })
    expect(fixture.agentMessages().map((message) => message.senderId)).toEqual([source.id, target.id])
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ fromAgentId: source.id, toAgentId: target.id, status: 'completed' }),
    ])
  })

  it('queues a busy direct Agent and runs its reply after the active Invocation settles', async () => {
    const fixture = await createFixture({ realQueue: true })
    const agent = fixture.createAgent('Solo', [])
    const firstGate = deferred<ConversationSessionResult>()
    fixture.sessions.handle = (input) => input.initialMessage.includes('first')
      ? firstGate.promise
      : Promise.resolve(publicReply('second answer'))
    const first = fixture.coordinator.start(fixture.postHuman('@Solo first'))
    await waitFor(() => fixture.sessions.calls.length === 1)
    const second = fixture.coordinator.start(fixture.postHuman('@Solo second'))
    await waitFor(() => fixture.repositories.listAgentInvocations(second.turn.id).length === 1)

    expect(fixture.repositories.listAgentInvocations(second.turn.id)[0]).toMatchObject({ status: 'queued' })
    expect(fixture.sessions.calls).toHaveLength(1)
    firstGate.resolve(publicReply('first answer'))
    await expect(first.completion).resolves.toMatchObject({ status: 'completed' })
    await expect(second.completion).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.agentMessages().map((message) => message.body)).toEqual(['first answer', 'second answer'])
    expect(fixture.repositories.getAgent(agent.id)?.status).toBe('idle')
  })

  it('limits ordinary-channel @all to current members', async () => {
    const fixture = await createFixture()
    const member = fixture.createAgent('Member', [])
    const outsider = fixture.repositories.createAgent({
      identity: 'Outsider', mentionName: 'outsider', runtime: 'opencode', capabilityTags: [], responsibilities: [],
      maxConcurrentTasks: 1, command: 'fake-runtime', args: [], model: '', env: {},
    })
    fixture.repositories.setAgentStatus(outsider.id, 'idle', new Date())
    fixture.sessions.handle = async (input) => publicReply(`${input.agent.identity} answer`)

    await fixture.coordinator.dispatch(fixture.postHuman('@all answer'))

    expect(fixture.sessions.calls.map((call) => call.agent.id)).toEqual([member.id])
    expect(fixture.sessions.calls.some((call) => call.agent.id === outsider.id)).toBe(false)
  })

  it('resolves summit @all membership dynamically for every Turn', async () => {
    const fixture = await createFixture({ channelSystemKey: 'summit' })
    fixture.createAgent('Alpha', [])
    fixture.createAgent('Beta', [])
    fixture.sessions.handle = async (input) => publicReply(`${input.agent.identity} answer`)

    await fixture.coordinator.dispatch(fixture.postHuman('@all first'))
    fixture.createAgent('Gamma', [])
    fixture.sessions.calls.length = 0
    await fixture.coordinator.dispatch(fixture.postHuman('@all second'))

    expect(fixture.sessions.calls.map((call) => call.agent.id))
      .toEqual(fixture.repositories.listAgents().map((agent) => agent.id))
  })

  it('rejects unknown mentions before creating a Turn', async () => {
    const fixture = await createFixture()
    fixture.createAgent('Known', [])
    const message = fixture.postHuman('@Unknown 请回答')

    expect(() => fixture.coordinator.dispatch(message)).toThrow('Unknown mention @Unknown.')
    const count = database!.database.prepare('SELECT COUNT(*) AS count FROM conversation_turns').get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('uses the timeout union shape guard and fails when no candidate replies after a timeout', async () => {
    const fixture = await createFixture({ participationProbeTimeoutMs: 5 })
    const slow = fixture.createAgent('Slow', ['timeout topic'])
    const quiet = fixture.createAgent('Quiet', ['timeout topic'])
    fixture.sessions.handle = (input) => input.agent.id === slow.id
      ? new Promise<ConversationSessionResult>(() => undefined)
      : Promise.resolve(participation('silent', 0.1))
    const message = fixture.postHuman('timeout topic')

    const turn = await fixture.coordinator.dispatch(message)

    expect(turn.status).toBe('failed')
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

  it('fails with persisted failure reasons when every selected response fails', async () => {
    const fixture = await createFixture()
    fixture.createAgent('One', ['failure topic'])
    fixture.createAgent('Two', ['failure topic'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 0.8)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      throw new Error(`response failed for ${input.agent.identity}`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('failure topic'))

    expect(turn.status).toBe('failed')
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

  it('recovers a failed Participation Participant only through a valid Handoff and records it as spoken', async () => {
    const fixture = await createFixture()
    const source = fixture.createAgent('Source', ['recovery handoff topic'])
    const target = fixture.createAgent('Target', ['recovery handoff topic'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') {
        if (input.agent.id === target.id) throw new Error('participation unavailable')
        return participation('speak', 1)
      }
      if (input.conversation?.kind === 'response') {
        return publicReply('source answer', [{ agentId: target.id, question: 'Recover through this Handoff.' }])
      }
      if (input.conversation?.kind === 'handoff_response') return publicReply('target recovered answer')
      throw new Error(`Unexpected invocation ${input.conversation?.kind}`)
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('recovery handoff topic'))
    const targetParticipant = fixture.repositories.listTurnParticipants(turn.id)
      .find((participant) => participant.agentId === target.id)

    expect(turn).toMatchObject({ status: 'partial', currentRound: 2 })
    expect(targetParticipant).toMatchObject({
      source: 'handoff',
      decision: 'speak',
      status: 'spoken',
      reason: null,
    })
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ fromAgentId: source.id, toAgentId: target.id, status: 'completed' }),
    ])
    expect(fixture.agentMessages()).toEqual([
      expect.objectContaining({ senderId: source.id, body: 'source answer' }),
      expect.objectContaining({ senderId: target.id, body: 'target recovered answer' }),
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

    expect(turn.status).toBe('partial')
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

  it('publishes the public coordinator lifecycle events only after the referenced state is persisted', async () => {
    const observed: string[] = []
    const fixture = await createFixture({
      onCoordinatorEvent: (event, repositories) => {
        if (!event.type.startsWith('conversation.')) return
        if (event.entityType === 'conversation_turn') {
          expect(repositories.getConversationTurn(event.entityId)).toBeDefined()
          if (event.type === 'conversation.turn_created') turnId = event.entityId
        }
        if (event.entityType === 'turn_participant') {
          expect(repositories.listTurnParticipants(turnId).some((participant) => participant.id === event.entityId)).toBe(true)
        }
        if (event.entityType === 'agent_invocation') {
          expect(repositories.listAgentInvocations(turnId).some((invocation) => invocation.id === event.entityId)).toBe(true)
        }
        if (event.entityType === 'conversation_handoff') {
          expect(repositories.listConversationHandoffs(turnId).some((handoff) => handoff.id === event.entityId)).toBe(true)
        }
        observed.push(event.type)
      },
    })
    const source = fixture.createAgent('Source', ['event topic'])
    const target = fixture.createAgent('Target', ['other topic'])
    let turnId = ''
    fixture.sessions.handle = async (input) => input.agent.id === source.id
      ? publicReply('source reply', [{ agentId: target.id, question: 'Please add detail.' }])
      : publicReply('target reply')

    const message = fixture.postHuman('@Source event topic')
    await fixture.coordinator.dispatch(message)

    expect(observed[0]).toBe('conversation.turn_created')
    expect(observed.at(-1)).toBe('conversation.turn_completed')
    expect(new Set(observed)).toEqual(new Set([
      'conversation.turn_created',
      'conversation.turn_updated',
      'conversation.participant_updated',
      'conversation.invocation_updated',
      'conversation.handoff_created',
      'conversation.turn_completed',
    ]))
  })

  it.each([
    ['completed', false],
    ['failed', true],
  ] as const)('publishes a Turn update after an accepted Handoff becomes %s', async (expectedStatus, targetFails) => {
    const observed: Array<{ type: string; entityId: string; handoffStatuses: string[] }> = []
    const fixture = await createFixture({
      onCoordinatorEvent: (event, repositories) => {
        if (!event.type.startsWith('conversation.')) return
        const turn = event.entityType === 'conversation_turn'
          ? repositories.getConversationTurn(event.entityId)
          : undefined
        observed.push({
          type: event.type,
          entityId: event.entityId,
          handoffStatuses: turn
            ? repositories.listConversationHandoffs(turn.id).map((handoff) => handoff.status)
            : [],
        })
      },
    })
    const source = fixture.createAgent('Source', ['handoff event topic'])
    const target = fixture.createAgent('Target', ['other topic'])
    fixture.sessions.handle = async (input) => {
      if (input.agent.id === source.id) {
        return publicReply('source reply', [{ agentId: target.id, question: 'Please continue.' }])
      }
      if (targetFails) throw new Error('target failed')
      return publicReply('target reply')
    }

    const turn = await fixture.coordinator.dispatch(fixture.postHuman('@Source handoff event topic'))
    const handoff = fixture.repositories.listConversationHandoffs(turn.id)[0]!
    const createdIndex = observed.findIndex((entry) => (
      entry.type === 'conversation.handoff_created' && entry.entityId === handoff.id
    ))
    const terminalUpdateIndex = observed.findIndex((entry, index) => (
      index > createdIndex
      && entry.type === 'conversation.turn_updated'
      && entry.entityId === turn.id
      && entry.handoffStatuses.includes(expectedStatus)
    ))

    expect(createdIndex).toBeGreaterThanOrEqual(0)
    expect(terminalUpdateIndex).toBeGreaterThan(createdIndex)
  })

  it('persists a partial Turn and the system reason when policy fails after a public reply', async () => {
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
    await expect(started.completion).resolves.toMatchObject({ status: 'partial' })
    expect(fixture.repositories.getConversationTurn(started.turn.id)).toMatchObject({ status: 'partial' })
    expect(fixture.repositories.listTurnParticipants(started.turn.id)).toEqual([
      expect.objectContaining({
        agentId: source.id,
        status: 'spoken',
        reason: 'coordinator_failed:policy infrastructure failed',
      }),
    ])
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

  it('keeps a queued Participation Participant cancelled after its async rejection settles', async () => {
    const fixture = await createFixture({ realQueue: true })
    const agent = fixture.createAgent('Solo', ['queued participation topic'])
    const blocker = deferred<ConversationSessionResult>()
    let blockerTurnId = ''
    fixture.sessions.handle = async (input) => input.conversation?.turnId === blockerTurnId
      ? blocker.promise
      : participation('speak', 1)
    const blockerStart = fixture.coordinator.start(fixture.postHuman('@Solo hold the lane'))
    blockerTurnId = blockerStart.turn.id
    await waitFor(() => fixture.sessions.calls.length === 1)
    const message = fixture.postHuman('queued participation topic')
    const started = fixture.coordinator.start(message)
    await waitFor(() => fixture.repositories.listAgentInvocations(started.turn.id).length === 1)
    const invocation = fixture.repositories.listAgentInvocations(started.turn.id)[0]!
    expect(invocation).toMatchObject({ kind: 'participation', status: 'queued' })

    await fixture.coordinator.cancel(started.turn.id)
    await expect(started.completion).resolves.toMatchObject({ status: 'cancelled' })

    expect(fixture.repositories.listAgentInvocations(started.turn.id)[0]).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listTurnParticipants(started.turn.id)[0]).toMatchObject({
      agentId: agent.id,
      status: 'cancelled',
      reason: 'turn_cancelled',
    })
    expect(fixture.sessions.cancelledInvocationIds).toEqual([])
    expect(fixture.agentMessages()).toEqual([])

    blocker.resolve(publicReply('blocker completed'))
    await expect(blockerStart.completion).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.sessions.calls).toHaveLength(1)
  })

  it('keeps a running Participation Participant cancelled after exact Session cancellation', async () => {
    const fixture = await createFixture({ realQueue: true })
    const agent = fixture.createAgent('Solo', ['running participation topic'])
    const gate = deferred<ConversationSessionResult>()
    fixture.sessions.handle = () => gate.promise
    const started = fixture.coordinator.start(fixture.postHuman('running participation topic'))
    await waitFor(() => fixture.sessions.calls.some((call) => call.conversation?.kind === 'participation'))
    const invocation = fixture.repositories.listAgentInvocations(started.turn.id)[0]!
    fixture.sessions.onCancelInvocation = (invocationId) => {
      if (invocationId === invocation.id) gate.reject(new ConversationInvocationCancelledError(invocationId))
    }

    await fixture.coordinator.cancel(started.turn.id)
    await expect(started.completion).resolves.toMatchObject({ status: 'cancelled' })

    expect(fixture.repositories.listAgentInvocations(started.turn.id)[0]).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listTurnParticipants(started.turn.id)[0]).toMatchObject({
      agentId: agent.id,
      status: 'cancelled',
      reason: 'turn_cancelled',
    })
    expect(fixture.sessions.cancelledInvocationIds).toEqual([invocation.id])
    expect(fixture.sessions.coarseCancellationCalls).toEqual([])
    expect(fixture.agentMessages()).toEqual([])
  })

  it('keeps a running duplicate-check Participant cancelled after exact Session cancellation', async () => {
    const fixture = await createFixture({ realQueue: true })
    fixture.createAgent('Candidate One', ['running duplicate topic'])
    fixture.createAgent('Candidate Two', ['running duplicate topic'])
    const duplicateGate = deferred<ConversationSessionResult>()
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 1)
      if (input.conversation?.kind === 'duplicate_check') return duplicateGate.promise
      return publicReply('first public reply')
    }
    const started = fixture.coordinator.start(fixture.postHuman('running duplicate topic'))
    await waitFor(() => fixture.sessions.calls.some((call) => call.conversation?.kind === 'duplicate_check'))
    const duplicateCall = fixture.sessions.calls.find((call) => call.conversation?.kind === 'duplicate_check')!
    const invocation = fixture.repositories.listAgentInvocations(started.turn.id)
      .find((candidate) => candidate.kind === 'duplicate_check')!
    fixture.sessions.onCancelInvocation = (invocationId) => {
      if (invocationId === invocation.id) {
        duplicateGate.reject(new ConversationInvocationCancelledError(invocationId))
      }
    }

    await fixture.coordinator.cancel(started.turn.id)
    await expect(started.completion).resolves.toMatchObject({ status: 'cancelled' })
    duplicateGate.resolve(duplicate('speak'))

    expect(fixture.repositories.listAgentInvocations(started.turn.id)
      .find((candidate) => candidate.id === invocation.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listTurnParticipants(started.turn.id)
      .find((participant) => participant.agentId === duplicateCall.agent.id)).toMatchObject({
        status: 'cancelled',
        reason: 'turn_cancelled',
      })
    expect(fixture.sessions.cancelledInvocationIds).toEqual([invocation.id])
    expect(fixture.sessions.coarseCancellationCalls).toEqual([])
    expect(fixture.agentMessages()).toHaveLength(1)
    expect(fixture.agentMessages().some((message) => message.senderId === duplicateCall.agent.id)).toBe(false)
  })

  it('removes a queued duplicate-check without cancelling another Turn or publishing a late reply', async () => {
    const fixture = await createFixture({ realQueue: true })
    fixture.createAgent('Candidate One', ['queued duplicate topic'])
    fixture.createAgent('Candidate Two', ['queued duplicate topic'])
    const firstResponseGate = deferred<ConversationSessionResult>()
    const blockerGate = deferred<ConversationSessionResult>()
    let ordinaryTurnId = ''
    let blockerTurnId = ''
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'participation') return participation('speak', 1)
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      if (input.conversation?.turnId === blockerTurnId) return blockerGate.promise
      if (input.conversation?.turnId === ordinaryTurnId) return firstResponseGate.promise
      throw new Error(`Unexpected Turn ${input.conversation?.turnId}`)
    }
    const ordinaryStart = fixture.coordinator.start(fixture.postHuman('queued duplicate topic'))
    ordinaryTurnId = ordinaryStart.turn.id
    await waitFor(() => fixture.sessions.calls.some((call) => (
      call.conversation?.turnId === ordinaryTurnId && call.conversation.kind === 'response'
    )))
    const secondParticipant = fixture.repositories.listTurnParticipants(ordinaryTurnId)
      .find((participant) => participant.speakingOrder === 2)!
    const secondAgent = fixture.repositories.getAgent(secondParticipant.agentId)!
    const blockerStart = fixture.coordinator.start(fixture.postHuman(`@${secondAgent.mentionName} occupy the lane`))
    blockerTurnId = blockerStart.turn.id
    await waitFor(() => fixture.sessions.calls.some((call) => call.conversation?.turnId === blockerTurnId))

    firstResponseGate.resolve(publicReply('ordinary first reply'))
    await waitFor(() => fixture.repositories.listAgentInvocations(ordinaryTurnId)
      .some((invocation) => invocation.kind === 'duplicate_check' && invocation.status === 'queued'))
    const duplicateInvocation = fixture.repositories.listAgentInvocations(ordinaryTurnId)
      .find((invocation) => invocation.kind === 'duplicate_check')!

    await fixture.coordinator.cancel(ordinaryTurnId)
    await expect(ordinaryStart.completion).resolves.toMatchObject({ status: 'cancelled' })

    expect(fixture.repositories.listAgentInvocations(ordinaryTurnId)
      .find((invocation) => invocation.id === duplicateInvocation.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listTurnParticipants(ordinaryTurnId)
      .find((participant) => participant.agentId === secondAgent.id)).toMatchObject({
        status: 'cancelled',
        reason: 'turn_cancelled',
      })
    expect(fixture.sessions.cancelledInvocationIds).toEqual([])
    expect(fixture.sessions.calls.filter((call) => call.conversation?.kind === 'duplicate_check')).toHaveLength(0)

    blockerGate.resolve(publicReply('other Turn reply'))
    await expect(blockerStart.completion).resolves.toMatchObject({ status: 'completed' })
    expect(fixture.agentMessages().map((message) => message.body)).toEqual([
      'ordinary first reply',
      'other Turn reply',
    ])
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

  it('reports live queue positions after priority insertion and lane progress', async () => {
    const fixture = await createFixture({ realQueue: true })
    const source = fixture.createAgent('Source', ['unrelated'])
    const target = fixture.createAgent('Target', ['unrelated'])
    const blockerGate = deferred<ConversationSessionResult>()
    const directGate = deferred<ConversationSessionResult>()
    const handoffGate = deferred<ConversationSessionResult>()
    let blockerTurnId = ''
    let directTurnId = ''
    fixture.sessions.handle = async (input) => {
      if (input.agent.id === source.id) {
        return publicReply('source reply', [{ agentId: target.id, question: 'Please follow up.' }])
      }
      if (input.conversation?.turnId === blockerTurnId) return blockerGate.promise
      if (input.conversation?.turnId === directTurnId) return directGate.promise
      if (input.conversation?.kind === 'handoff_response') return handoffGate.promise
      throw new Error(`Unexpected invocation ${input.conversation?.turnId}`)
    }

    const blocker = fixture.coordinator.start(fixture.postHuman('@Target occupy the lane'))
    blockerTurnId = blocker.turn.id
    await waitFor(() => fixture.sessions.calls.some((call) => call.conversation?.turnId === blockerTurnId))

    const handoff = fixture.coordinator.start(fixture.postHuman('@Source create a handoff'))
    await waitFor(() => fixture.repositories.listAgentInvocations(handoff.turn.id)
      .some((invocation) => invocation.kind === 'handoff_response' && invocation.status === 'queued'))

    const direct = fixture.coordinator.start(fixture.postHuman('@Target urgent direct'))
    directTurnId = direct.turn.id
    await waitFor(() => fixture.repositories.listAgentInvocations(directTurnId)
      .some((invocation) => invocation.kind === 'response' && invocation.status === 'queued'))

    let activities = fixture.coordinator.getActiveStates(fixture.channel.id)
    expect(activities.find((activity) => activity.turnId === directTurnId)).toMatchObject({
      phase: 'queued',
      queuePosition: 2,
    })
    expect(activities.find((activity) => activity.turnId === handoff.turn.id && activity.agentId === target.id)).toMatchObject({
      phase: 'queued',
      queuePosition: 3,
    })

    blockerGate.resolve(publicReply('blocker done'))
    await blocker.completion
    await waitFor(() => fixture.repositories.listAgentInvocations(directTurnId)
      .some((invocation) => invocation.status === 'running'))
    activities = fixture.coordinator.getActiveStates(fixture.channel.id)
    expect(activities.find((activity) => activity.turnId === directTurnId)).toMatchObject({
      phase: 'preparing',
      queuePosition: null,
    })
    expect(activities.find((activity) => activity.turnId === handoff.turn.id && activity.agentId === target.id)).toMatchObject({
      phase: 'queued',
      queuePosition: 2,
    })

    directGate.resolve(publicReply('direct done'))
    await direct.completion
    await waitFor(() => fixture.repositories.listAgentInvocations(handoff.turn.id)
      .some((invocation) => invocation.kind === 'handoff_response' && invocation.status === 'running'))
    handoffGate.resolve(publicReply('handoff done'))
    await handoff.completion
  })

  it('cancels persisted active Turns during channel cancellation after a restart', async () => {
    const fixture = await createFixture()
    const agent = fixture.createAgent('Persisted', ['restart'])
    const message = fixture.postHuman('@Persisted restart')
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    fixture.repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: agent.id,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      status: 'selected',
    })
    const invocation = fixture.repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: agent.id,
      kind: 'response',
      priority: 'human_direct',
      round: 1,
      idempotencyKey: `${turn.id}:persisted`,
      sourceInvocationId: null,
      status: 'running',
      startedAt: '2026-07-31T08:00:00.000Z',
    })
    const sessionKey = `${fixture.channel.id}:timeline:${agent.id}`
    fixture.repositories.upsertConversationSession({
      key: sessionKey,
      channelId: fixture.channel.id,
      threadRootMessageId: null,
      agentId: agent.id,
      runtime: agent.runtime,
      runtimeSessionId: 'persisted-runtime-session',
      runtimeSessionFile: null,
      status: 'active',
      lastMessageId: message.id,
    })

    await fixture.coordinator.cancelChannel(fixture.channel.id)

    expect(fixture.repositories.getConversationTurn(turn.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ id: invocation.id, status: 'cancelled' }),
    ])
    expect(fixture.repositories.getConversationSession(sessionKey)).toMatchObject({
      runtimeSessionId: 'persisted-runtime-session',
      status: 'stale',
    })
  })

  it('recovers the full ordinary Turn state machine from persisted participation results through round-two handoff', async () => {
    const fixture = await createFixture()
    const alpha = fixture.createAgent('Alpha Recovery', ['recovery topic'])
    const beta = fixture.createAgent('Beta Recovery', ['recovery topic'])
    const gamma = fixture.createAgent('Gamma Recovery', ['follow-up'])
    const message = fixture.postHuman('recovery topic')
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })
    fixture.repositories.updateConversationTurn(turn.id, { status: 'judging' })
    for (const [index, agent] of [alpha, beta].entries()) {
      fixture.repositories.createTurnParticipant({
        turnId: turn.id,
        agentId: agent.id,
        source: 'responsibility',
        rank: index + 1,
        matcherScore: 10 - index,
      })
      fixture.repositories.createAgentInvocation({
        turnId: turn.id,
        agentId: agent.id,
        kind: 'participation',
        priority: 'participation',
        round: 0,
        idempotencyKey: `${turn.id}:0:participation:${agent.id}`,
        sourceInvocationId: null,
        status: 'settled',
        completedAt: '2026-08-01T00:00:00.000Z',
        resultJson: JSON.stringify(participation('speak', 0.9 - index / 10)),
      })
    }
    fixture.repositories.updateAgentResponsibilities(alpha.id, ['responsibility changed after crash'])
    fixture.repositories.updateAgentResponsibilities(beta.id, ['responsibility changed after crash'])
    fixture.sessions.handle = async (input) => {
      if (input.conversation?.kind === 'duplicate_check') return duplicate('speak')
      if (input.conversation?.kind === 'handoff_response') return publicReply('gamma recovered handoff')
      if (input.agent.id === alpha.id) {
        return publicReply('alpha recovered response', [{ agentId: gamma.id, question: 'continue recovery?' }])
      }
      return publicReply('beta recovered response')
    }

    await fixture.coordinator.recover()
    await waitFor(() => fixture.repositories.getConversationTurn(turn.id)?.status === 'completed')

    expect(fixture.sessions.calls.map((call) => call.conversation?.kind)).toEqual([
      'response', 'duplicate_check', 'response', 'handoff_response',
    ])
    expect(fixture.agentMessages().map((persisted) => persisted.body)).toEqual([
      'alpha recovered response', 'beta recovered response', 'gamma recovered handoff',
    ])
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ toAgentId: gamma.id, round: 2, status: 'completed' }),
    ])
    expect(fixture.repositories.listAgentInvocations(turn.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: gamma.id, kind: 'handoff_response', round: 2, status: 'settled' }),
    ]))
  })

  it('claims a recovered Turn once and cancellation fences a late Runtime result from settlement and publication', async () => {
    const fixture = await createFixture()
    const agent = fixture.createAgent('Claimed Recovery', ['restart'])
    const message = fixture.postHuman('@Claimed Recovery restart')
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    fixture.repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: agent.id,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      speakingOrder: 1,
      status: 'selected',
    })
    const invocation = fixture.repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: agent.id,
      kind: 'response',
      priority: 'human_direct',
      round: 1,
      idempotencyKey: `${turn.id}:1:response:${agent.id}`,
      sourceInvocationId: null,
      status: 'running',
      startedAt: '2026-08-01T00:00:00.000Z',
    })
    const responseGate = deferred<ConversationSessionResult>()
    fixture.sessions.handle = () => responseGate.promise

    await fixture.coordinator.recover()
    await waitFor(() => fixture.sessions.calls.length === 1)
    await fixture.coordinator.recover()
    expect(fixture.sessions.calls).toHaveLength(1)

    await fixture.coordinator.cancel(turn.id)
    responseGate.resolve(publicReply('must not publish'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fixture.repositories.getConversationTurn(turn.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ id: invocation.id, status: 'cancelled' }),
    ])
    expect(fixture.agentMessages()).toEqual([])
  })

  it('lets an expired claim move across Coordinators without the old owner cancelling the takeover Invocation', async () => {
    const fixture = await createFixture()
    const agent = fixture.createAgent('Lease Recovery', ['restart'])
    const message = fixture.postHuman('@Lease Recovery restart')
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    fixture.repositories.createTurnParticipant({
      turnId: turn.id, agentId: agent.id, source: 'direct', rank: 1, matcherScore: null,
      decision: 'speak', speakingOrder: 1, status: 'selected',
    })
    fixture.repositories.createAgentInvocation({
      turnId: turn.id, agentId: agent.id, kind: 'response', priority: 'human_direct', round: 1,
      idempotencyKey: `${turn.id}:1:response:${agent.id}`, sourceInvocationId: null,
      status: 'running', startedAt: '2026-08-01T00:00:00.000Z',
    })
    const firstGate = deferred<ConversationSessionResult>()
    const secondGate = deferred<ConversationSessionResult>()
    const firstSessions = new ScriptedSessions()
    const secondSessions = new ScriptedSessions()
    firstSessions.handle = () => firstGate.promise
    secondSessions.handle = () => secondGate.promise
    let firstNow = new Date('2026-08-02T00:00:00.000Z')
    let secondNow = new Date('2026-08-02T00:00:01.000Z')
    const first = new ChannelTurnCoordinator({
      repositories: fixture.repositories,
      sessions: firstSessions,
      recoveryOwnerId: 'owner-a',
      recoveryClaimTtlMs: 30_000,
      recoveryHeartbeatMs: 1_000_000,
      now: () => firstNow,
    })
    const secondDatabase = createSqliteDatabase(path.join(temporaryDirectory!, 'sinapsis.sqlite'))
    const secondRepositories = new SqliteRepositories(secondDatabase, new RecordingPublisher())
    const second = new ChannelTurnCoordinator({
      repositories: secondRepositories,
      sessions: secondSessions,
      recoveryOwnerId: 'owner-b',
      recoveryClaimTtlMs: 30_000,
      recoveryHeartbeatMs: 1_000_000,
      now: () => secondNow,
    })

    try {
      await first.recover()
      await waitFor(() => firstSessions.calls.length === 1)
      await second.recover()
      expect(secondSessions.calls).toEqual([])

      secondNow = new Date('2026-08-02T00:00:31.000Z')
      await second.recover()
      await waitFor(() => secondSessions.calls.length === 1)
      expect(secondRepositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'running' })

      firstNow = new Date('2026-08-02T00:00:32.000Z')
      firstGate.resolve(publicReply('stale owner reply'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(secondRepositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'running' })
      expect(fixture.agentMessages()).toEqual([])

      secondGate.resolve(publicReply('takeover reply'))
      await waitFor(() => secondRepositories.getConversationTurn(turn.id)?.status === 'completed')
      expect(secondRepositories.listAgentInvocations(turn.id)[0]).toMatchObject({ status: 'settled' })
      expect(fixture.agentMessages().map((persisted) => persisted.body)).toEqual(['takeover reply'])
    } finally {
      secondDatabase.close()
    }
  })

  it('replays settled duplicate, response, and handoff state without treating handoff Participants as first-round candidates', async () => {
    const fixture = await createFixture()
    const alpha = fixture.createAgent('Settled Alpha', ['persisted chain'])
    const beta = fixture.createAgent('Settled Beta', ['persisted chain'])
    const gamma = fixture.createAgent('Settled Gamma', ['follow-up'])
    const message = fixture.postHuman('persisted chain')
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'ordinary',
      maxRounds: 3,
    })
    fixture.repositories.updateConversationTurn(turn.id, { status: 'handoff', currentRound: 2 })
    for (const [agent, rank, matcherScore] of [[alpha, 1, 10], [beta, 2, -1]] as const) {
      fixture.repositories.createTurnParticipant({
        turnId: turn.id, agentId: agent.id, source: 'responsibility', rank, matcherScore,
        decision: 'speak', confidence: 1, proposedAngle: agent.identity,
        speakingOrder: rank, status: 'selected',
      })
      fixture.repositories.createAgentInvocation({
        turnId: turn.id, agentId: agent.id, kind: 'participation', priority: 'participation', round: 0,
        idempotencyKey: `${turn.id}:0:participation:${agent.id}`, sourceInvocationId: null,
        status: 'settled', completedAt: '2026-08-01T00:00:00.000Z',
        resultJson: JSON.stringify(participation('speak', 1)),
      })
    }
    fixture.repositories.createTurnParticipant({
      turnId: turn.id, agentId: gamma.id, source: 'handoff', rank: 3, matcherScore: null,
      decision: 'speak', speakingOrder: 3, status: 'selected',
    })
    const alphaResponse = fixture.repositories.createAgentInvocation({
      turnId: turn.id, agentId: alpha.id, kind: 'response', priority: 'human_ordinary', round: 1,
      idempotencyKey: `${turn.id}:1:response:${alpha.id}`, sourceInvocationId: null, status: 'running',
    })
    fixture.repositories.settleConversationInvocation({
      invocationId: alphaResponse.id,
      recoveryOwnerId: null,
      resultJson: JSON.stringify(publicReply('settled alpha', [{ agentId: gamma.id, question: 'settled handoff?' }])),
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: alpha.identity, body: 'settled alpha' },
      occurredAt: new Date('2026-08-01T00:00:01.000Z'),
    })
    const betaDuplicate = fixture.repositories.createAgentInvocation({
      turnId: turn.id, agentId: beta.id, kind: 'duplicate_check', priority: 'duplicate_check', round: 1,
      idempotencyKey: `${turn.id}:1:duplicate_check:${beta.id}`, sourceInvocationId: null, status: 'running',
    })
    fixture.repositories.settleConversationInvocation({
      invocationId: betaDuplicate.id,
      recoveryOwnerId: null,
      resultJson: JSON.stringify(duplicate('speak')),
      occurredAt: new Date('2026-08-01T00:00:02.000Z'),
    })
    const betaResponse = fixture.repositories.createAgentInvocation({
      turnId: turn.id, agentId: beta.id, kind: 'response', priority: 'human_ordinary', round: 1,
      idempotencyKey: `${turn.id}:1:response:${beta.id}`, sourceInvocationId: null, status: 'running',
    })
    fixture.repositories.settleConversationInvocation({
      invocationId: betaResponse.id,
      recoveryOwnerId: null,
      resultJson: JSON.stringify(publicReply('settled beta')),
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: beta.identity, body: 'settled beta' },
      occurredAt: new Date('2026-08-01T00:00:03.000Z'),
    })
    const handoff = fixture.repositories.createConversationHandoff({
      turnId: turn.id, sourceInvocationId: alphaResponse.id, fromAgentId: alpha.id,
      requestedTargetAgentId: gamma.id, toAgentId: gamma.id, question: 'settled handoff?',
      round: 2, status: 'completed',
    })
    const gammaResponse = fixture.repositories.createAgentInvocation({
      turnId: turn.id, agentId: gamma.id, kind: 'handoff_response', priority: 'automatic_handoff', round: 2,
      idempotencyKey: `${turn.id}:2:handoff_response:${gamma.id}`,
      sourceInvocationId: alphaResponse.id, status: 'running',
    })
    fixture.repositories.settleConversationInvocation({
      invocationId: gammaResponse.id,
      recoveryOwnerId: null,
      resultJson: JSON.stringify(publicReply('settled gamma')),
      participantPatch: { status: 'spoken' },
      publicReply: { authorName: gamma.identity, body: 'settled gamma' },
      occurredAt: new Date('2026-08-01T00:00:04.000Z'),
    })
    const messageIds = fixture.agentMessages().map((persisted) => persisted.id)
    fixture.sessions.handle = async () => publicReply('unexpected replay')

    await fixture.coordinator.recover()
    await waitFor(() => fixture.repositories.getConversationTurn(turn.id)?.status === 'completed')

    expect(fixture.sessions.calls).toEqual([])
    expect(fixture.agentMessages().map((persisted) => persisted.id)).toEqual(messageIds)
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({ id: handoff.id, round: 2, status: 'completed' }),
    ])
    expect(fixture.repositories.listAgentInvocations(turn.id)).toHaveLength(6)
  })

  it('keeps a persisted Invocation retryable when stale persistence fails', async () => {
    const fixture = await createFixture()
    const agent = fixture.createAgent('Retryable', ['restart'])
    const message = fixture.postHuman('@Retryable restart')
    const turn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    fixture.repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: agent.id,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      status: 'selected',
    })
    const invocation = fixture.repositories.createAgentInvocation({
      turnId: turn.id,
      agentId: agent.id,
      kind: 'response',
      priority: 'human_direct',
      round: 1,
      idempotencyKey: `${turn.id}:retryable`,
      sourceInvocationId: null,
      status: 'running',
      startedAt: '2026-07-31T08:00:00.000Z',
    })
    const sessionKey = `${fixture.channel.id}:timeline:${agent.id}`
    fixture.repositories.upsertConversationSession({
      key: sessionKey,
      channelId: fixture.channel.id,
      threadRootMessageId: null,
      agentId: agent.id,
      runtime: agent.runtime,
      runtimeSessionId: 'retryable-runtime-session',
      runtimeSessionFile: null,
      status: 'active',
      lastMessageId: message.id,
    })
    const upsert = fixture.repositories.upsertConversationSession.bind(fixture.repositories)
    let failStale = true
    vi.spyOn(fixture.repositories, 'upsertConversationSession').mockImplementation((input) => {
      if (input.status === 'stale' && failStale) throw new Error('stale persistence failed')
      return upsert(input)
    })

    await expect(fixture.coordinator.cancel(turn.id)).rejects.toThrow('stale persistence failed')
    expect(fixture.repositories.getConversationTurn(turn.id)?.status).not.toBe('cancelled')
    expect(fixture.repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ id: invocation.id, status: 'running' }),
    ])

    failStale = false
    await expect(fixture.coordinator.cancel(turn.id)).resolves.toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.getConversationSession(sessionKey)?.status).toBe('stale')
    expect(fixture.repositories.listAgentInvocations(turn.id)).toEqual([
      expect.objectContaining({ id: invocation.id, status: 'cancelled' }),
    ])
  })

  it('cancels only the removed Agent persisted Turn while preserving other restart work', async () => {
    const fixture = await createFixture()
    const removed = fixture.createAgent('Removed', ['restart'])
    const retained = fixture.createAgent('Retained', ['restart'])
    const createPersistedDirectTurn = (agent: Agent) => {
      const message = fixture.postHuman(`@${agent.identity} restart`)
      const turn = fixture.repositories.createConversationTurn({
        channelId: fixture.channel.id,
        triggerMessageId: message.id,
        threadRootMessageId: null,
        mode: 'direct',
        maxRounds: 3,
      })
      fixture.repositories.createTurnParticipant({
        turnId: turn.id,
        agentId: agent.id,
        source: 'direct',
        rank: 1,
        matcherScore: null,
        decision: 'speak',
        status: 'selected',
      })
      fixture.repositories.createAgentInvocation({
        turnId: turn.id,
        agentId: agent.id,
        kind: 'response',
        priority: 'human_direct',
        round: 1,
        idempotencyKey: `${turn.id}:persisted`,
        sourceInvocationId: null,
      })
      return turn
    }
    const removedTurn = createPersistedDirectTurn(removed)
    const retainedTurn = createPersistedDirectTurn(retained)
    const removedSessionKey = `${fixture.channel.id}:timeline:${removed.id}`
    const retainedSessionKey = `${fixture.channel.id}:timeline:${retained.id}`
    for (const [agent, key] of [[removed, removedSessionKey], [retained, retainedSessionKey]] as const) {
      fixture.repositories.upsertConversationSession({
        key,
        channelId: fixture.channel.id,
        threadRootMessageId: null,
        agentId: agent.id,
        runtime: agent.runtime,
        runtimeSessionId: `${agent.identity}-runtime-session`,
        runtimeSessionFile: null,
        status: 'ready',
        lastMessageId: null,
      })
    }
    const screeningMessage = fixture.postHuman('@Removed before invocation')
    const screeningTurn = fixture.repositories.createConversationTurn({
      channelId: fixture.channel.id,
      triggerMessageId: screeningMessage.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    fixture.repositories.createTurnParticipant({
      turnId: screeningTurn.id,
      agentId: removed.id,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      status: 'selected',
    })

    await fixture.coordinator.cancelAgentInChannel(fixture.channel.id, removed.id)

    expect(fixture.repositories.getConversationTurn(removedTurn.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.getConversationTurn(screeningTurn.id)).toMatchObject({ status: 'cancelled' })
    expect(fixture.repositories.listAgentInvocations(removedTurn.id)).toEqual([
      expect.objectContaining({ agentId: removed.id, status: 'cancelled' }),
    ])
    expect(fixture.repositories.getConversationTurn(retainedTurn.id)).toMatchObject({ status: 'screening' })
    expect(fixture.repositories.listAgentInvocations(retainedTurn.id)).toEqual([
      expect.objectContaining({ agentId: retained.id, status: 'queued' }),
    ])
    expect(fixture.repositories.getConversationSession(removedSessionKey)?.status).toBe('stale')
    expect(fixture.repositories.getConversationSession(retainedSessionKey)?.status).toBe('ready')
  })

  async function createFixture(options: {
    participationProbeTimeoutMs?: number
    onCoordinatorEvent?: (event: DomainEvent, repositories: WorkspaceRepositories) => void
    realQueue?: boolean
    handoffPolicy?: HandoffPolicy
    channelSystemKey?: string
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
    const channel = repositories.createChannel({
      name: options.channelSystemKey ?? 'general',
      systemKey: options.channelSystemKey,
    })
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
        snapshotInvocation: () => ({ state: 'not_found' as const, position: null }),
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
      if (!options.channelSystemKey) repositories.addChannelAgent(channel.id, agent.id, new Date())
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
  cancellationAttempts: string[] = []
  coarseCancellationCalls: string[] = []
  cancellationFailure: Error | undefined
  cancellationFailures = new Map<string, Error>()
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
    this.cancellationAttempts.push(invocationId)
    const invocationFailure = this.cancellationFailures.get(invocationId)
    if (invocationFailure) return Promise.reject(invocationFailure)
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
