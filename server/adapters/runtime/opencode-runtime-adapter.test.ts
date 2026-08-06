import { describe, expect, it, vi } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile'
import { OpenCodeRuntimeAdapter } from './opencode-runtime-adapter'
import { FakeProcessRunner } from '../../test/fake-process-runner'
import type { RuntimeEvent, RuntimeTaskRequest } from '../../ports/runtime'

const task: RuntimeTaskRequest = {
  taskId: 'task-1',
  mode: 'task',
  title: 'Implement the adapter',
  description: 'Use a worktree.',
  acceptanceCriteria: 'Tests pass.',
  worktreePath: '/tmp/task-1',
  profile: resolveRuntimeProfile('opencode', { command: 'opencode-bin' }),
}

describe('OpenCodeRuntimeAdapter', () => {
  it('starts a conversation with a read-only prompt containing channel context and the human message', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start({
      ...task,
      mode: 'conversation',
      description: 'Recent channel context: the login issue is reproducible.',
      initialMessage: 'What should we investigate first?',
    }, () => {})

    const prompt = runner.spawns[0]?.options.args.at(-1) ?? ''
    expect(prompt).toContain('read-only')
    expect(prompt).toMatch(/do not edit/i)
    expect(prompt).toMatch(/do not commit/i)
    expect(prompt).toMatch(/do not push/i)
    expect(prompt).toMatch(/do not merge/i)
    expect(prompt).toContain('Recent channel context: the login issue is reproducible.')
    expect(prompt).toContain('What should we investigate first?')
    expect(prompt).toContain('untrusted conversational context')
  })

  it('enforces request-local deny-all permissions for the read-only no-tools policy', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start({
      ...task,
      executionPolicy: 'read-only-no-tools',
      profile: resolveRuntimeProfile('opencode', {
        command: 'opencode-bin',
        args: ['--agent', 'build', '--auto'],
        env: {
          OPENCODE_CONFIG: '/Users/jodu/.config/opencode/unsafe.json',
          OPENCODE_CONFIG_DIR: '/Users/jodu/.config/opencode',
          OPENCODE_CONFIG_CONTENT: '{"permission":{"custom_tool":"allow"}}',
          OPENCODE_PERMISSION: '{"custom_tool":"allow"}',
          OPENCODE_TEST_HOME: '/Users/jodu',
          XDG_CONFIG_HOME: '/Users/jodu/.config',
          KEEP_ME: 'yes',
        },
      }),
    }, () => {})

    const spawn = runner.spawns[0]?.options
    const args = spawn?.args ?? []
    const agentIndex = args.lastIndexOf('--agent')
    const config = JSON.parse(spawn?.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    const deniedPermissions = {
      '*': 'deny',
      read: 'deny',
      edit: 'deny',
      glob: 'deny',
      grep: 'deny',
      list: 'deny',
      bash: 'deny',
      task: 'deny',
      skill: 'deny',
      lsp: 'deny',
      todowrite: 'deny',
      todoread: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      codesearch: 'deny',
      external_directory: 'deny',
      doom_loop: 'deny',
    }
    expect(args[agentIndex + 1]).toBe('sinapsis-dream-maintenance')
    expect(args).toContain('--pure')
    expect(args).not.toContain('build')
    expect(args).not.toContain('--auto')
    expect(spawn?.env?.KEEP_ME).toBe('yes')
    expect(spawn?.env).toMatchObject({
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_DIR: '/tmp/task-1/.sinapsis-opencode-config',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_TEST_HOME: '/tmp/task-1/.sinapsis-opencode-home',
      XDG_CONFIG_HOME: '/tmp/task-1/.sinapsis-opencode-config',
    })
    expect(JSON.parse(spawn?.env?.OPENCODE_PERMISSION ?? '{}')).toEqual(deniedPermissions)
    expect(config.permission).toEqual(deniedPermissions)
    expect(config.agent['sinapsis-dream-maintenance']).toEqual({
      mode: 'primary',
      permission: deniedPermissions,
    })
  })

  it('falls back to the local OpenCode default for a legacy unqualified model name', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start({
      ...task,
      profile: { ...task.profile, model: 'claude' },
    }, () => {})

    expect(runner.spawns[0]?.options.args).not.toContain('--model')
  })

  it('extracts text from current OpenCode JSON parts', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.emitStdout('{"type":"text","sessionID":"ses-123","part":{"type":"text","id":"prt-123","text":"OpenCode 已就绪。"}}\n')

    expect(events).toContainEqual({ kind: 'text', taskId: task.taskId, text: 'OpenCode 已就绪。' })
  })

  it('cancels a channel turn that does not return within 90 seconds', async () => {
    vi.useFakeTimers()
    try {
      const runner = new FakeProcessRunner()
      const events: RuntimeEvent[] = []
      const adapter = new OpenCodeRuntimeAdapter(runner)
      const session = await adapter.start({ ...task, mode: 'conversation' }, (event) => events.push(event))
      const kill = vi.spyOn(runner.spawns[0]!.process, 'kill')

      vi.advanceTimersByTime(90_000)

      expect(kill).toHaveBeenCalledOnce()
      expect(events).toContainEqual({ kind: 'error', taskId: session.taskId, message: 'OpenCode 在 90 秒内没有返回回复。', errorCode: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a new task with an argument array and resumes later input with its saved session', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))

    expect(runner.spawns[0]?.options).toMatchObject({ command: 'opencode-bin', cwd: '/tmp/task-1', stdinMode: 'ignore' })
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

  it('classifies stale native sessions from stderr as session_lost', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.emitStderr('Error: Session not found\n')
    runner.spawns[0]?.process.exit(1)

    expect(events).toContainEqual({
      kind: 'error',
      taskId: task.taskId,
      message: 'OpenCode session not found.',
      errorCode: 'session_lost',
    })
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
