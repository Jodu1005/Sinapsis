import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase, type SqliteDatabase } from '../adapters/sqlite/database'
import { SqliteRepositories } from '../adapters/sqlite/sqlite-repositories'
import type { Agent } from '../domain/agent'
import type { DomainEvent } from '../domain/events'
import type { Message } from '../domain/message'
import type { DomainEventPublisher } from '../ports/domain-event-publisher'
import type { WorkspaceRepositories } from '../ports/repositories'
import type {
  ConversationSessionInvocation,
  ConversationSessionResult,
} from './conversation-session-service'
import { ChannelMessageService } from './channel-message-service'
import { ChannelTurnCoordinator } from './channel-turn-coordinator'

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
      expect.objectContaining({ authorName: source.identity, body: 'source answer', threadRootMessageId: root.id }),
      expect.objectContaining({ authorName: target.identity, body: 'target answer', threadRootMessageId: root.id }),
    ])
    expect(fixture.repositories.listConversationHandoffs(turn.id)).toEqual([
      expect.objectContaining({
        fromAgentId: source.id,
        toAgentId: target.id,
        question: 'Please verify.',
        round: 2,
        status: 'accepted',
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

  async function createFixture(options: {
    participationProbeTimeoutMs?: number
    onCoordinatorEvent?: (event: DomainEvent, repositories: WorkspaceRepositories) => void
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
      queue: {
        enqueue: (invocation) => invocation.run(),
        cancel: () => undefined,
        snapshot: (agentId) => ({ running: queueAvailability.get(agentId) === false, queued: 0 }),
      },
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
      const message = messages.postAgent(channel.id, null, agent.identity, 'earlier reply')
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
  handle: (input: ConversationSessionInvocation) => Promise<ConversationSessionResult> = async () => participation('silent', 0)

  invoke(input: ConversationSessionInvocation): Promise<ConversationSessionResult> {
    this.calls.push(input)
    return this.handle(input)
  }

  cancelChannel(): Promise<{ cancelledSessionKeys: string[] }> {
    return Promise.resolve({ cancelledSessionKeys: [] })
  }

  cancelAgentInChannel(): Promise<{ cancelledSessionKeys: string[] }> {
    return Promise.resolve({ cancelledSessionKeys: [] })
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
