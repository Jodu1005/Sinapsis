import { afterEach, describe, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSqliteDatabase } from './adapters/sqlite/database'
import { SqliteRepositories } from './adapters/sqlite/sqlite-repositories'
import type { DomainEventPublisher } from './ports/domain-event-publisher'

describe('local service shutdown', () => {
  let child: ChildProcess | undefined
  let temporaryDirectory: string | undefined

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child, 2_000)
    }
    child = undefined
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  })

  it('closes SSE clients before waiting for the HTTP server to close', async () => {
    const port = await reservePort()
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-shutdown-'))
    child = startMain({ ...process.env, SINAPSIS_PORT: String(port), SINAPSIS_DATA_DIR: temporaryDirectory })

    const startupOutput = await waitForOutput(child.stdout!, 'Dream maintenance scheduled')
    const humanCapability = /humanCapability=([^\s]+)/.exec(startupOutput)?.[1]
    expect(humanCapability).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await fetch(`http://127.0.0.1:${port}/api/memory-candidates?status=pending`)).status).toBe(403)
    const authorizedReview = await fetch(`http://127.0.0.1:${port}/api/memory-candidates?status=pending`, {
      headers: { 'x-sinapsis-human-capability': humanCapability! },
    })
    expect(authorizedReview.status).toBe(200)
    await expect(authorizedReview.json()).resolves.toEqual([])
    const response = await fetch(`http://127.0.0.1:${port}/events`)
    expect(response.status).toBe(200)

    child.send('sinapsis:shutdown')

    await expect(waitForExit(child, 2_000)).resolves.toBe(0)
    await response.body?.cancel()
  })

  it('claims and resumes a persisted running conversation Invocation during real main startup', async () => {
    const port = await reservePort()
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-main-recovery-'))
    const databasePath = path.join(temporaryDirectory, 'sinapsis.sqlite')
    const seeded = createSqliteDatabase(databasePath)
    const repositories = new SqliteRepositories(seeded, new NoopPublisher())
    const workspace = repositories.createWorkspace({ name: 'Main recovery' })
    repositories.createRepository({
      workspaceId: workspace.id,
      name: 'main-recovery',
      path: temporaryDirectory,
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ name: 'main-recovery' })
    const agent = repositories.createAgent({
      identity: 'Startup Recovery',
      mentionName: 'startup-recovery',
      runtime: 'opencode',
      capabilityTags: [],
      responsibilities: [],
      maxConcurrentTasks: 1,
      command: 'sinapsis-command-that-does-not-exist',
      args: [],
      model: '',
      env: {},
    })
    repositories.setAgentStatus(agent.id, 'idle', new Date())
    repositories.addChannelAgent(channel.id, agent.id, new Date())
    const message = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'You',
      body: '@Startup Recovery resume after restart',
    })
    const turn = repositories.createConversationTurn({
      channelId: channel.id,
      triggerMessageId: message.id,
      threadRootMessageId: null,
      mode: 'direct',
      maxRounds: 3,
    })
    repositories.createTurnParticipant({
      turnId: turn.id,
      agentId: agent.id,
      source: 'direct',
      rank: 1,
      matcherScore: null,
      decision: 'speak',
      speakingOrder: 1,
      status: 'selected',
    })
    const invocation = repositories.createAgentInvocation({
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
    seeded.close()

    child = startMain({ ...process.env, SINAPSIS_PORT: String(port), SINAPSIS_DATA_DIR: temporaryDirectory })
    await waitForOutput(child.stdout!, 'Sinapsis local service listening')
    const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then((response) => response.json()) as {
      channels: Array<{ id: string }>
    }
    expect(bootstrap.channels).toEqual(expect.arrayContaining([expect.objectContaining({ id: channel.id })]))

    const reader = new DatabaseSync(databasePath)
    try {
      await waitForCondition(() => {
        const row = reader.prepare('SELECT status FROM conversation_turns WHERE id = ?')
          .get(turn.id) as { status: string }
        return row.status === 'completed' || row.status === 'partial' || row.status === 'cancelled' || row.status === 'failed'
      }, 2_000, () => JSON.stringify({
        turn: reader.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(turn.id),
        invocation: reader.prepare('SELECT * FROM agent_invocations WHERE id = ?').get(invocation.id),
        agent: reader.prepare('SELECT status FROM agents WHERE id = ?').get(agent.id),
      }))
      expect(reader.prepare('SELECT status FROM agent_invocations WHERE id = ?').get(invocation.id))
        .toEqual({ status: 'failed' })
      expect(reader.prepare('SELECT status FROM conversation_turns WHERE id = ?').get(turn.id))
        .toEqual({ status: 'failed' })
      expect(reader.prepare(`
        SELECT COUNT(*) AS count FROM messages
        WHERE channel_id = ? AND sender_type = 'agent'
      `).get(channel.id)).toEqual({ count: 0 })
    } finally {
      reader.close()
    }
  })

  it('atomically fails interrupted Dream runs and quarantines only candidates without a valid source', async () => {
    const port = await reservePort()
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-dream-recovery-'))
    const databasePath = path.join(temporaryDirectory, 'sinapsis.sqlite')
    const seeded = createSqliteDatabase(databasePath)
    const repositories = new SqliteRepositories(seeded, new NoopPublisher())
    const workspace = repositories.createWorkspace({ name: 'Dream recovery' })
    repositories.createRepository({
      workspaceId: workspace.id,
      name: 'dream-recovery',
      path: temporaryDirectory,
      currentBranch: 'main',
      defaultBranch: 'main',
      isClean: true,
    })
    const channel = repositories.createChannel({ name: 'dream-recovery' })
    const completedSource = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'You',
      body: 'Completed watermark source',
    })
    const completedRun = repositories.createIncrementalDreamRun({ channelId: channel.id, trigger: 'manual' })
    repositories.updateDreamRun(completedRun.id, {
      status: 'completed',
      startedAt: '2026-08-03T00:00:00.000Z',
      completedAt: '2026-08-03T00:00:01.000Z',
    })
    const interruptedSource = repositories.createMessage({
      channelId: channel.id,
      senderType: 'human',
      authorName: 'You',
      body: 'Interrupted source with private content that must not enter audit logs',
    })
    const interruptedRun = repositories.createIncrementalDreamRun({ channelId: channel.id, trigger: 'manual' })
    repositories.updateDreamRun(interruptedRun.id, {
      status: 'running',
      startedAt: '2026-08-03T00:00:02.000Z',
    })
    const validCandidate = repositories.createMemoryCandidate({
      dreamRunId: interruptedRun.id,
      proposedScope: 'channel',
      channelId: channel.id,
      kind: 'fact',
      proposedContent: 'Valid pending memory',
      rationale: 'Backed by a retained source.',
      confidence: 0.9,
      importance: 0.8,
      sourceMessageIds: [interruptedSource.id],
    })
    const invalidCandidate = repositories.createMemoryCandidate({
      dreamRunId: interruptedRun.id,
      proposedScope: 'channel',
      channelId: channel.id,
      kind: 'fact',
      proposedContent: 'Private candidate content must not enter audit logs',
      rationale: 'This row has no source.',
      confidence: 0.9,
      importance: 0.8,
      sourceMessageIds: [],
    })
    seeded.close()

    child = startMain({
      ...process.env,
      SINAPSIS_PORT: String(port),
      SINAPSIS_DATA_DIR: temporaryDirectory,
      SINAPSIS_DREAM_ENABLED: 'false',
    })
    await waitForOutput(child.stdout!, 'Sinapsis local service listening')

    const reader = new DatabaseSync(databasePath)
    try {
      const recovered = reader.prepare(`
        SELECT status, error, completed_at FROM dream_runs WHERE id = ?
      `).get(interruptedRun.id) as { status: string; error: string | null; completed_at: string | null }
      expect(recovered).toEqual({
        status: 'failed',
        error: 'service_restarted',
        completed_at: expect.any(String),
      })
      expect(reader.prepare(`
        SELECT scope_id, to_message_created_at, to_message_id
        FROM dream_runs
        WHERE scope_id = ? AND status = 'completed' AND to_message_id IS NOT NULL
        ORDER BY to_message_created_at DESC, to_message_id DESC
        LIMIT 1
      `).get(channel.id)).toEqual({
        scope_id: channel.id,
        to_message_created_at: completedSource.createdAt,
        to_message_id: completedSource.id,
      })
      expect(reader.prepare(`
        SELECT status, reviewed_at FROM memory_candidates WHERE id = ?
      `).get(validCandidate.id)).toEqual({ status: 'pending', reviewed_at: null })
      expect(reader.prepare(`
        SELECT status, reviewed_at FROM memory_candidates WHERE id = ?
      `).get(invalidCandidate.id)).toEqual({ status: 'superseded', reviewed_at: expect.any(String) })

      const auditRows = reader.prepare(`
        SELECT entity_type, entity_id, error FROM dream_recovery_audit ORDER BY entity_type, entity_id
      `).all() as Array<{ entity_type: string; entity_id: string; error: string }>
      expect(auditRows).toEqual([
        { entity_type: 'memory_candidate', entity_id: invalidCandidate.id, error: 'invalid_candidate_sources' },
      ])
      expect(JSON.stringify(auditRows)).not.toContain('Private candidate content')
      expect(JSON.stringify(auditRows)).not.toContain('Interrupted source')
    } finally {
      reader.close()
    }
  })
})

class NoopPublisher implements DomainEventPublisher {
  publish(): void {}
}

function startMain(environment: NodeJS.ProcessEnv): ChildProcess {
  return fork(path.join(process.cwd(), 'server/main.ts'), [], {
    cwd: process.cwd(),
    env: environment,
    execArgv: ['--import', 'tsx'],
    silent: true,
  })
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function waitForOutput(output: NodeJS.ReadableStream, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Did not receive: ${expected}`)), 5_000)
    let received = ''
    output.on('data', (chunk: Buffer) => {
      received += chunk.toString()
      if (!received.includes(expected)) return
      clearTimeout(timeout)
      resolve(received)
    })
  })
}

function waitForExit(process: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (process.exitCode !== null) return Promise.resolve(process.exitCode)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs)
    process.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

async function waitForCondition(condition: () => boolean, timeoutMs: number, describe = () => ''): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for startup recovery. ${describe()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
