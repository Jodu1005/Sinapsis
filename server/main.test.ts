import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
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
    child?.kill('SIGKILL')
    child = undefined
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  })

  it('closes SSE clients before waiting for the HTTP server to close', async () => {
    const port = await reservePort()
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-shutdown-'))
    child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['server/main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, SINAPSIS_PORT: String(port), SINAPSIS_DATA_DIR: temporaryDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await waitForOutput(child.stdout!, 'Dream maintenance scheduled')
    const response = await fetch(`http://127.0.0.1:${port}/events`)
    expect(response.status).toBe(200)

    child.kill('SIGTERM')

    await expect(waitForExit(child, 500)).resolves.toBe(0)
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

    child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['server/main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, SINAPSIS_PORT: String(port), SINAPSIS_DATA_DIR: temporaryDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
})

class NoopPublisher implements DomainEventPublisher {
  publish(): void {}
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function waitForOutput(output: NodeJS.ReadableStream, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Did not receive: ${expected}`)), 2_000)
    output.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes(expected)) return
      clearTimeout(timeout)
      resolve()
    })
  })
}

function waitForExit(process: ChildProcess, timeoutMs: number): Promise<number | null> {
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
