import { describe, expect, it, vi } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile'
import { OpenCodeRuntimeAdapter } from './opencode-runtime-adapter'
import { FakeProcessRunner } from '../../test/fake-process-runner'
import type { RuntimeEvent, RuntimeTaskRequest } from '../../ports/runtime'

const task: RuntimeTaskRequest = {
  taskId: 'task-1',
  title: 'Implement the adapter',
  description: 'Use a worktree.',
  acceptanceCriteria: 'Tests pass.',
  worktreePath: '/tmp/task-1',
  profile: resolveRuntimeProfile('opencode', { command: 'opencode-bin' }),
}

describe('OpenCodeRuntimeAdapter', () => {
  it('starts a new task with an argument array and resumes later input with its saved session', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))

    expect(runner.spawns[0]?.options).toMatchObject({ command: 'opencode-bin', cwd: '/tmp/task-1' })
    expect(runner.spawns[0]?.options.args).toEqual(expect.arrayContaining([
      'run', '--format', 'json', '--dir', '/tmp/task-1',
    ]))
    expect(runner.spawns[0]?.options.args.join(' ')).toContain('Implement the adapter')
    expect(runner.spawns[0]?.options.args.join(' ')).toContain(task.description)
    expect(runner.spawns[0]?.options.args.some((arg) => arg.includes('push') && arg.includes('merge'))).toBe(true)

    runner.spawns[0]?.process.emitStdout('{"type":"session","sessionID":"ses-123"}\n')
    runner.spawns[0]?.process.exit()
    adapter.sendInput(session, 'Please also check types.', (event) => events.push(event))

    expect(runner.spawns[1]?.options).toMatchObject({
      command: 'opencode-bin',
      cwd: '/tmp/task-1',
      args: ['run', '--format', 'json', '--dir', '/tmp/task-1', '--session', 'ses-123', 'Please also check types.'],
    })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'artifact', artifactType: 'runtime-jsonl' }))
    const exitArtifact = events.filter((event): event is Extract<RuntimeEvent, { kind: 'artifact' }> =>
      event.kind === 'artifact' && event.artifactType === 'runtime-exit',
    ).at(-1)
    expect(JSON.parse(exitArtifact?.content ?? '{}')).toMatchObject({
      command: 'opencode-bin',
      cwd: '/tmp/task-1',
      args: expect.arrayContaining(['run', '--format', 'json', '--dir', '/tmp/task-1']),
      code: 0,
    })
  })

  it('records a child-process launch error as task runtime evidence', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.emitError(new Error('spawn opencode-bin ENOENT'))

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'error',
      taskId: task.taskId,
      message: 'spawn opencode-bin ENOENT',
    }))
  })

  it('emits settled exactly once when a successful final run has no pending input', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.exit(0)

    expect(events.filter((event) => event.kind === 'settled')).toEqual([
      { kind: 'settled', taskId: task.taskId },
    ])
  })

  it('starts a queued follow-up after a successful run without settling early', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    adapter.sendInput(session, 'Please check one more thing.', (event) => events.push(event))
    runner.spawns[0]?.process.exit(0)

    expect(runner.spawns).toHaveLength(2)
    expect(events.filter((event) => event.kind === 'settled')).toEqual([])

    runner.spawns[1]?.process.exit(0)

    expect(events.filter((event) => event.kind === 'settled')).toEqual([
      { kind: 'settled', taskId: task.taskId },
    ])
  })

  it('reports a non-zero exit as an error rather than settling the task', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.exit(1)

    expect(events).toContainEqual({
      kind: 'error',
      taskId: task.taskId,
      message: 'OpenCode exited with 1.',
    })
    expect(events.filter((event) => event.kind === 'settled')).toEqual([])
  })

  it('cancels its managed process for a session', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new OpenCodeRuntimeAdapter(runner)
    const session = await adapter.start(task, () => {})
    const process = runner.spawns[0]?.process
    const kill = vi.spyOn(process!, 'kill')

    adapter.cancel(session)

    expect(kill).toHaveBeenCalledOnce()
  })
})
