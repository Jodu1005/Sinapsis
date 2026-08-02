import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FakeRuntimeAdapter } from '../adapters/runtime/fake-runtime-adapter'
import type { RuntimeProfile } from '../adapters/runtime/runtime-profile'
import type { AgentInvocation } from '../domain/conversation'
import type { MemoryCandidate, MemoryRecord } from '../domain/memory'
import type { Message } from '../domain/message'
import type { Channel } from '../domain/workspace'
import type { ConversationTurnDetails } from '../ports/repositories'
import type { CreateMemoryCandidateInput } from '../domain/memory'
import type { RuntimeEventSink, RuntimeSession, RuntimeTaskRequest } from '../ports/runtime'
import { memoryContentHash } from './memory-consolidation-protocol'
import { MemoryConsolidator } from './memory-consolidator'

describe('MemoryConsolidator', () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  it('starts one independent read-only conversation Runtime in the Dream run directory without conversation metadata or session reuse', async () => {
    const fixture = await createFixture()
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    const request = fixture.runtime.starts[0]!
    expect(request).toMatchObject({
      taskId: fixture.input.runId,
      mode: 'conversation',
      worktreePath: path.join(fixture.dataDir, 'dream', fixture.input.runId),
      profile,
    })
    expect(request.conversation).toBeUndefined()
    expect(fixture.runtime.resumes).toEqual([])
    expect(fixture.runtime.inputs).toEqual([])

    settle(fixture, { candidates: [] })
    await expect(operation).resolves.toEqual([])
  })

  it('builds a safe JSON prompt from only public messages, public Turn results, and accepted memories', async () => {
    const fixture = await createFixture()
    const publicResponse = invocation('response', JSON.stringify({
      text: '{"reply":"Public Turn reply.","handoffTo":[]}',
      parsed: { reply: 'Public Turn reply.', handoffTo: [] },
    }))
    const legacyPublicResponse = invocation('handoff_response', JSON.stringify({ reply: 'Legacy public reply.', handoffTo: [] }))
    const privateDecision = invocation('participation', JSON.stringify({ decision: 'speak', reason: 'PRIVATE_REASON' }))
    fixture.input.channel = { ...fixture.input.channel, privateRuntimeMetadata: 'PRIVATE_CHANNEL' } as Channel
    fixture.input.messages = [{ ...fixture.input.messages[0]!, runtimeArtifact: 'PRIVATE_MESSAGE_ARTIFACT' } as Message]
    fixture.input.turns = [{
      ...turnDetails([publicResponse, legacyPublicResponse, privateDecision]),
      runtimeArtifact: 'PRIVATE_TURN_ARTIFACT',
    } as ConversationTurnDetails]
    fixture.input.acceptedMemories = [{ ...acceptedMemory(), privateReasoning: 'PRIVATE_MEMORY_REASONING' } as MemoryRecord]

    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))
    const request = fixture.runtime.starts[0]!
    const prompt = JSON.parse(request.description) as Record<string, unknown>
    const serializedPrompt = request.description

    expect(prompt).toEqual({
      instruction: expect.any(String),
      channel: { id: 'channel-1', name: 'general' },
      messages: [{ id: 'message-1', authorName: 'Jodu', body: 'The user prefers Chinese.', createdAt: '2026-08-02T08:00:00.000Z' }],
      turnPublicResults: [
        { turnId: 'turn-1', invocationId: publicResponse.id, reply: 'Public Turn reply.' },
        { turnId: 'turn-1', invocationId: legacyPublicResponse.id, reply: 'Legacy public reply.' },
      ],
      acceptedMemories: [{ scope: 'global', kind: 'preference', content: 'User prefers English.' }],
    })
    for (const forbidden of [
      'PRIVATE_CHANNEL', 'PRIVATE_MESSAGE_ARTIFACT', 'PRIVATE_TURN_ARTIFACT', 'PRIVATE_REASON',
      'PRIVATE_MEMORY_REASONING', 'PROFILE_ENV_SECRET', 'runtimeArtifact', 'privateReasoning',
    ]) expect(serializedPrompt).not.toContain(forbidden)

    settle(fixture, { candidates: [] })
    await operation
  })

  it('collects text chunks and parses them only after the Runtime settles', async () => {
    const fixture = await createFixture()
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    const raw = JSON.stringify({ candidates: [proposedMemory()] })
    fixture.runtime.emit(fixture.input.runId, { kind: 'text', text: raw.slice(0, 30) })
    expect(fixture.repositories.created).toEqual([])
    fixture.runtime.emit(fixture.input.runId, { kind: 'text', text: raw.slice(30) })
    expect(fixture.repositories.created).toEqual([])
    fixture.runtime.emit(fixture.input.runId, { kind: 'settled' })

    await expect(operation).resolves.toEqual([expect.objectContaining({ proposedContent: 'User prefers Chinese.' })])
    expect(fixture.repositories.created).toHaveLength(1)
  })

  it('treats an empty candidate result as a no-op', async () => {
    const fixture = await createFixture()
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    settle(fixture, { candidates: [] })

    await expect(operation).resolves.toEqual([])
    expect(fixture.repositories.created).toEqual([])
  })

  it('does not create a candidate that duplicates an accepted Memory after normalization', async () => {
    const fixture = await createFixture()
    fixture.input.acceptedMemories = [acceptedMemory({ content: 'User prefers Chinese.' })]
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    settle(fixture, { candidates: [proposedMemory({ content: '  User prefers Chinese.  ' })] })

    await expect(operation).resolves.toEqual([])
    expect(fixture.repositories.created).toEqual([])
  })

  it('keeps a potential same-scope conflict and appends an explicit human-review rationale', async () => {
    const fixture = await createFixture()
    fixture.input.acceptedMemories = [acceptedMemory({ content: 'User prefers English.' })]
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    settle(fixture, { candidates: [proposedMemory()] })

    const [candidate] = await operation
    expect(candidate).toMatchObject({ proposedContent: 'User prefers Chinese.' })
    expect(candidate?.rationale).toMatch(/Potential conflict with accepted Memory memory-1; human review required\./)
  })

  it('creates no candidates when settled Runtime text fails strict parsing', async () => {
    const fixture = await createFixture()
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    fixture.runtime.emit(fixture.input.runId, { kind: 'text', text: '{"candidates":[{"scope":"global"}]}' })
    fixture.runtime.emit(fixture.input.runId, { kind: 'settled' })

    await expect(operation).rejects.toThrow(/Memory candidate/)
    expect(fixture.repositories.created).toEqual([])
  })

  it('cancels the independent session on timeout and creates no candidates', async () => {
    vi.useFakeTimers()
    const fixture = await createFixture({ timeoutMs: 25 })
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))
    const rejection = expect(operation).rejects.toThrow(/timed out after 25ms/)

    await vi.advanceTimersByTimeAsync(25)

    await rejection
    expect(fixture.runtime.cancellations).toHaveLength(1)
    expect(fixture.repositories.created).toEqual([])
  })

  it('times out while Runtime start is pending and cancels a session that arrives late', async () => {
    vi.useFakeTimers()
    const runtime = new DeferredStartRuntime()
    const fixture = await createFixture({ timeoutMs: 25, runtime })
    const operation = fixture.consolidator.consolidate(fixture.input)
    const observed = operation.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(runtime.starts).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(25)
    const outcome = await Promise.race([observed, Promise.resolve('pending' as const)])
    runtime.releaseStart()
    await vi.advanceTimersByTimeAsync(0)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/timed out after 25ms/)
    expect(runtime.cancellations).toHaveLength(1)
    expect(fixture.repositories.created).toEqual([])
  })

  it('rejects cross-channel messages before starting Runtime', async () => {
    const fixture = await createFixture()
    fixture.input.messages.push(message({ id: 'message-2', channelId: 'channel-2' }))
    const operation = fixture.consolidator.consolidate(fixture.input)
    const observed = operation.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (fixture.runtime.starts.length > 0) settle(fixture, { candidates: [] })

    const result = await observed
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toMatch(/message-2.*channel-1/)
    expect(fixture.runtime.starts).toHaveLength(0)
    expect(fixture.repositories.created).toEqual([])
  })

  it('rejects cross-channel Turn details before starting Runtime', async () => {
    const fixture = await createFixture()
    const foreignTurn = turnDetails([])
    foreignTurn.turn.channelId = 'channel-2'
    fixture.input.turns.push(foreignTurn)

    const result = await observePreflight(fixture)

    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toMatch(/turn-1.*channel-1/)
    expect(fixture.runtime.starts).toHaveLength(0)
  })

  it('rejects a run ID that can escape or nest outside its Dream run directory', async () => {
    const fixture = await createFixture()
    fixture.input.runId = '../escaped-run'

    const result = await observePreflight(fixture)

    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toMatch(/safe letters, numbers, hyphens, and underscores/)
    expect(fixture.runtime.starts).toHaveLength(0)
  })

  it('validates timeout and candidate limits at construction', async () => {
    const fixture = await createFixture()
    const options = {
      repositories: fixture.repositories,
      runtime: fixture.runtime,
      dataDir: fixture.dataDir,
      profile,
    }

    expect(() => new MemoryConsolidator({ ...options, timeoutMs: 0, maxCandidates: 20 }))
      .toThrow(/timeoutMs must be a positive integer/)
    expect(() => new MemoryConsolidator({ ...options, timeoutMs: 1.5, maxCandidates: 20 }))
      .toThrow(/timeoutMs must be a positive integer/)
    expect(() => new MemoryConsolidator({ ...options, timeoutMs: 1_000, maxCandidates: 0 }))
      .toThrow(/maxCandidates must be an integer from 1 through 50/)
    expect(() => new MemoryConsolidator({ ...options, timeoutMs: 1_000, maxCandidates: 51 }))
      .toThrow(/maxCandidates must be an integer from 1 through 50/)
  })

  it('cancels the independent session on Runtime error and creates no candidates', async () => {
    const fixture = await createFixture()
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    fixture.runtime.emit(fixture.input.runId, { kind: 'error', message: 'Runtime unavailable' })

    await expect(operation).rejects.toThrow(/Runtime unavailable/)
    expect(fixture.runtime.cancellations).toHaveLength(1)
    expect(fixture.repositories.created).toEqual([])
  })

  it('writes Runtime artifacts only as local evidence inside the run directory', async () => {
    const fixture = await createFixture()
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    fixture.runtime.emit(fixture.input.runId, {
      kind: 'artifact', artifactType: 'runtime-jsonl', content: 'PRIVATE_RUNTIME_ARTIFACT',
    })
    settle(fixture, { candidates: [proposedMemory()] })
    const candidates = await operation

    const runDirectory = path.join(fixture.dataDir, 'dream', fixture.input.runId)
    const files = await readdir(runDirectory)
    expect(files).toEqual(['runtime-jsonl.log'])
    expect(await readFile(path.join(runDirectory, files[0]!), 'utf8')).toBe('PRIVATE_RUNTIME_ARTIFACT')
    expect(JSON.stringify(candidates)).not.toContain('PRIVATE_RUNTIME_ARTIFACT')
    expect(JSON.stringify(fixture.repositories.created)).not.toContain('PRIVATE_RUNTIME_ARTIFACT')
  })

  it('ignores archived and other-channel accepted Memories when checking duplicates and conflicts', async () => {
    const fixture = await createFixture()
    fixture.input.acceptedMemories = [
      acceptedMemory({
        id: 'archived-current', scope: 'channel', channelId: 'channel-1', kind: 'fact',
        content: 'Channel uses SQLite.', status: 'archived', archivedAt: '2026-08-02T07:30:00.000Z',
      }),
      acceptedMemory({
        id: 'active-other-channel', scope: 'channel', channelId: 'channel-2', kind: 'fact',
        content: 'Channel uses SQLite.',
      }),
    ]
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    settle(fixture, { candidates: [proposedMemory({
      scope: 'channel', kind: 'fact', content: 'Channel uses SQLite.', rationale: 'Confirmed here.',
    })] })

    const [candidate] = await operation
    expect(candidate).toMatchObject({ proposedScope: 'channel', channelId: 'channel-1', rationale: 'Confirmed here.' })
  })

  it('deduplicates against an active Memory from the current channel', async () => {
    const fixture = await createFixture()
    fixture.input.acceptedMemories = [acceptedMemory({
      scope: 'channel', channelId: 'channel-1', kind: 'fact', content: 'Channel uses SQLite.',
    })]
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    settle(fixture, { candidates: [proposedMemory({
      scope: 'channel', kind: 'fact', content: ' Channel uses SQLite. ',
    })] })

    await expect(operation).resolves.toEqual([])
    expect(fixture.repositories.created).toEqual([])
  })

  it('does not mark unrelated same-scope and same-kind Memories as conflicts', async () => {
    const fixture = await createFixture()
    fixture.input.acceptedMemories = [acceptedMemory({ content: 'Frontend prefers React.' })]
    const operation = fixture.consolidator.consolidate(fixture.input)
    await vi.waitFor(() => expect(fixture.runtime.starts).toHaveLength(1))

    settle(fixture, { candidates: [proposedMemory()] })

    const [candidate] = await operation
    expect(candidate?.rationale).toBe('The user confirmed this preference.')
  })

  async function createFixture(options: { timeoutMs?: number; runtime?: FakeRuntimeAdapter } = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'sinapsis-memory-consolidator-'))
    temporaryDirectories.push(dataDir)
    const runtime = options.runtime ?? new FakeRuntimeAdapter()
    const repositories = new RecordingMemoryRepositories()
    const consolidator = new MemoryConsolidator({
      repositories,
      runtime,
      dataDir,
      profile,
      timeoutMs: options.timeoutMs ?? 1_000,
      maxCandidates: 20,
    })
    return {
      dataDir,
      runtime,
      repositories,
      consolidator,
      input: {
        runId: 'dream-run-1',
        channel: channel(),
        messages: [message()],
        turns: [] as ConversationTurnDetails[],
        acceptedMemories: [] as MemoryRecord[],
      },
    }
  }

  async function observePreflight(fixture: Awaited<ReturnType<typeof createFixture>>) {
    const operation = fixture.consolidator.consolidate(fixture.input)
    const observed = operation.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (fixture.runtime.starts.length > 0) settle(fixture, { candidates: [] })
    return observed
  }
})

const profile: RuntimeProfile = {
  runtime: 'pi', command: 'pi', args: ['--mode', 'rpc'], model: 'dream-model',
  env: { DREAM_SECRET: 'PROFILE_ENV_SECRET' }, policy: 'task-worktree',
}

class RecordingMemoryRepositories {
  readonly created: CreateMemoryCandidateInput[] = []

  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidate {
    this.created.push(input)
    return {
      id: `candidate-${this.created.length}`,
      dreamRunId: input.dreamRunId,
      proposedScope: input.proposedScope,
      channelId: input.channelId,
      kind: input.kind,
      proposedContent: input.proposedContent,
      rationale: input.rationale,
      confidence: input.confidence,
      importance: input.importance,
      contentHash: memoryContentHash(input.proposedContent),
      status: 'pending',
      reviewedContent: null,
      reviewedScope: null,
      reviewedAt: null,
      createdAt: '2026-08-02T09:00:00.000Z',
    }
  }
}

class DeferredStartRuntime extends FakeRuntimeAdapter {
  private pendingSession: RuntimeSession | undefined
  private resolveStart: ((session: RuntimeSession) => void) | undefined

  override async start(task: RuntimeTaskRequest, sink: RuntimeEventSink): Promise<RuntimeSession> {
    this.pendingSession = await super.start(task, sink)
    return new Promise<RuntimeSession>((resolve) => { this.resolveStart = resolve })
  }

  releaseStart(): void {
    if (!this.pendingSession || !this.resolveStart) throw new Error('Deferred Runtime start is not pending.')
    this.resolveStart(this.pendingSession)
  }
}

function settle(fixture: { runtime: FakeRuntimeAdapter; input: { runId: string } }, value: unknown): void {
  fixture.runtime.emit(fixture.input.runId, { kind: 'text', text: JSON.stringify(value) })
  fixture.runtime.emit(fixture.input.runId, { kind: 'settled' })
}

function proposedMemory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'global', kind: 'preference', content: 'User prefers Chinese.',
    rationale: 'The user confirmed this preference.', confidence: 0.9, importance: 0.8,
    sourceMessageIds: ['message-1'], ...overrides,
  }
}

function channel(): Channel {
  return {
    id: 'channel-1', name: 'general', systemKey: null, memberAgentIds: [], boundWorkspaceIds: [],
    createdAt: '2026-08-02T07:00:00.000Z',
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1', channelId: 'channel-1', threadRootMessageId: null, taskId: null,
    senderType: 'human', senderId: null, authorName: 'Jodu', body: 'The user prefers Chinese.',
    createdAt: '2026-08-02T08:00:00.000Z', updatedAt: '2026-08-02T08:00:00.000Z', deletedAt: null,
    ...overrides,
  }
}

function acceptedMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const content = overrides.content ?? 'User prefers English.'
  return {
    id: 'memory-1', scope: 'global', channelId: null, kind: 'preference', content,
    contentHash: memoryContentHash(content), status: 'active', sourceCandidateId: 'accepted-candidate-1',
    archivedAt: null, createdAt: '2026-08-01T08:00:00.000Z', updatedAt: '2026-08-01T08:00:00.000Z',
    ...overrides,
  }
}

function turnDetails(invocations: AgentInvocation[]): ConversationTurnDetails {
  return {
    turn: {
      id: 'turn-1', channelId: 'channel-1', triggerMessageId: 'message-1', threadRootMessageId: null,
      mode: 'ordinary', status: 'completed', currentRound: 1, maxRounds: 2,
      createdAt: '2026-08-02T08:00:00.000Z', updatedAt: '2026-08-02T08:01:00.000Z',
      completedAt: '2026-08-02T08:01:00.000Z',
    },
    participants: [], invocations, handoffs: [],
  }
}

function invocation(kind: AgentInvocation['kind'], resultJson: string): AgentInvocation {
  return {
    id: `invocation-${kind}`, turnId: 'turn-1', agentId: 'agent-1', kind,
    priority: kind === 'participation' ? 'participation' : 'human_ordinary', round: 1,
    status: 'settled', idempotencyKey: `key-${kind}`, sourceInvocationId: null,
    queuedAt: '2026-08-02T08:00:00.000Z', startedAt: '2026-08-02T08:00:01.000Z',
    completedAt: '2026-08-02T08:00:02.000Z', errorCode: null, resultJson,
  }
}
