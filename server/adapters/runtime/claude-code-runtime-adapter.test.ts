import { describe, expect, it, vi } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile'
import { ClaudeCodeRuntimeAdapter } from './claude-code-runtime-adapter'
import { FakeProcessRunner } from '../../test/fake-process-runner'
import type { RuntimeEvent, RuntimeTaskRequest } from '../../ports/runtime'

const task: RuntimeTaskRequest = {
  taskId: 'task-claude',
  mode: 'task',
  title: 'Implement Claude adapter',
  description: 'Use Claude Code inside the assigned worktree.',
  acceptanceCriteria: 'Stream output and settle safely.',
  worktreePath: '/tmp/task-claude',
  profile: resolveRuntimeProfile('claude-code', { command: 'claude-bin' }),
}

describe('ClaudeCodeRuntimeAdapter', () => {
  it('starts a conversation with a read-only prompt containing channel context and the human message', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    await adapter.start({
      ...task,
      mode: 'conversation',
      description: 'Recent channel context: mobile layout is overflowing.',
      initialMessage: 'Can you explain the likely cause?',
    }, () => {})

    const prompt = runner.spawns[0]?.options.args.at(-1) ?? ''
    expect(prompt).toContain('read-only')
    expect(prompt).toMatch(/do not edit/i)
    expect(prompt).toMatch(/do not commit/i)
    expect(prompt).toMatch(/do not push/i)
    expect(prompt).toMatch(/do not merge/i)
    expect(prompt).toContain('Recent channel context: mobile layout is overflowing.')
    expect(prompt).toContain('Can you explain the likely cause?')
    expect(prompt).toContain('untrusted conversational context')
  })

  it('enforces the read-only no-tools execution policy over profile arguments', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    await adapter.start({
      ...task,
      executionPolicy: 'read-only-no-tools',
      profile: resolveRuntimeProfile('claude-code', {
        command: 'claude-bin',
        args: ['--tools', 'Edit', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions', '--bare'],
      }),
    }, () => {})

    const args = runner.spawns[0]?.options.args ?? []
    const toolsIndex = args.lastIndexOf('--tools')
    const permissionModeIndex = args.lastIndexOf('--permission-mode')
    expect(args[toolsIndex + 1]).toBe('')
    expect(args[permissionModeIndex + 1]).toBe('dontAsk')
    expect(args).toEqual(expect.arrayContaining([
      '--safe-mode',
      '--no-session-persistence',
      '--disable-slash-commands',
    ]))
    expect(args).not.toContain('Edit')
    expect(args).not.toContain('acceptEdits')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--bare')
  })

  it('starts a new task with a generated UUID session and resumes later input with --resume', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    const firstSpawn = runner.spawns[0]

    expect(firstSpawn?.options).toMatchObject({ command: 'claude-bin', cwd: '/tmp/task-claude' })
    expect(firstSpawn?.options.args.slice(0, 7)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--session-id',
    ])
    expect(firstSpawn?.options.args[7]).toMatch(UUID_PATTERN)
    expect(firstSpawn?.options.args.join(' ')).toContain('Implement Claude adapter')
    expect(firstSpawn?.options.args.join(' ')).toContain(task.description)
    expect(session.sessionId).toMatch(UUID_PATTERN)

    runner.spawns[0]?.process.emitStdout(`{"type":"system","subtype":"init","session_id":"${session.sessionId}"}\n`)
    runner.spawns[0]?.process.exit(0)

    adapter.sendInput(session, 'Also inspect error handling.', (event) => events.push(event))

    expect(runner.spawns[1]?.options).toMatchObject({
      command: 'claude-bin',
      cwd: '/tmp/task-claude',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--resume',
        session.sessionId,
        'Also inspect error handling.',
      ],
    })
    expect(events).toContainEqual({ kind: 'session', taskId: task.taskId, sessionId: session.sessionId! })
  })

  it('translates assistant text, tool activity, and stream errors into runtime events', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]?.process

    process?.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it."},{"type":"tool_use","id":"toolu_1","name":"Edit"}]}}\n')
    process?.emitStdout('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","name":"Edit","is_error":false}]}}\n')
    process?.emitStdout('{"type":"error","error":{"message":"Claude hit a rate limit."}}\n')

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'text', taskId: task.taskId, text: 'Working on it.' }),
      expect.objectContaining({ kind: 'tool_start', taskId: task.taskId, toolName: 'Edit', toolCallId: 'toolu_1' }),
      expect.objectContaining({ kind: 'tool_end', taskId: task.taskId, toolName: 'Edit', toolCallId: 'toolu_1', success: true }),
      expect.objectContaining({ kind: 'error', taskId: task.taskId, message: 'Claude hit a rate limit.' }),
    ]))
  })

  it('publishes only the final result for a channel conversation', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    await adapter.start({
      ...task,
      mode: 'conversation',
      initialMessage: '土耳其的首都是哪里？',
    }, (event) => events.push(event))
    const process = runner.spawns[0]?.process

    process?.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"让我先查一下。"},{"type":"tool_use","id":"toolu_1","name":"Read"}]}}\n')
    process?.emitStdout('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","name":"Read","content":"长篇工具输出"}]}}\n')
    process?.emitStdout('{"type":"result","subtype":"success","result":"土耳其的首都是安卡拉。"}\n')

    expect(events.filter((event) => event.kind === 'text')).toEqual([
      { kind: 'text', taskId: task.taskId, text: '土耳其的首都是安卡拉。' },
    ])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_start', toolName: 'Read' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_end', toolName: 'Read' }))
  })

  it('emits settled exactly once after a successful final run', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.exit(0)

    expect(events.filter((event) => event.kind === 'settled')).toEqual([
      { kind: 'settled', taskId: task.taskId },
    ])
  })

  it('starts queued follow-up input before settling the task', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    adapter.sendInput(session, 'Double-check the tests.', (event) => events.push(event))
    runner.spawns[0]?.process.exit(0)

    expect(runner.spawns).toHaveLength(2)
    expect(runner.spawns[1]?.options.args).toContain('--resume')
    expect(events.filter((event) => event.kind === 'settled')).toEqual([])

    runner.spawns[1]?.process.exit(0)

    expect(events.filter((event) => event.kind === 'settled')).toEqual([
      { kind: 'settled', taskId: task.taskId },
    ])
  })

  it('reports a non-zero exit as an error instead of settling', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.exit(1)

    expect(events).toContainEqual({
      kind: 'error',
      taskId: task.taskId,
      message: 'Claude Code exited with 1.',
    })
    expect(events.filter((event) => event.kind === 'settled')).toEqual([])
  })

  it('redacts secret arguments in exit metadata', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new ClaudeCodeRuntimeAdapter(runner)

    const taskWithSecrets: RuntimeTaskRequest = {
      ...task,
      profile: resolveRuntimeProfile('claude-code', {
        command: 'claude-bin',
        args: ['--api-key', 'super-secret', '--token=also-secret'],
      }),
    }

    await adapter.start(taskWithSecrets, (event) => events.push(event))
    runner.spawns[0]?.process.exit(0)

    const exitArtifact = [...events].reverse().find((event): event is Extract<RuntimeEvent, { kind: 'artifact' }> =>
      event.kind === 'artifact' && event.artifactType === 'runtime-exit',
    )

    expect(JSON.parse(exitArtifact?.content ?? '{}')).toMatchObject({
      command: 'claude-bin',
      cwd: '/tmp/task-claude',
      args: expect.arrayContaining(['--api-key', '[REDACTED]', '--token=[REDACTED]']),
      code: 0,
    })
  })

  it('cancels only its managed child process for a session', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new ClaudeCodeRuntimeAdapter(runner)
    const session = await adapter.start(task, () => {})
    const process = runner.spawns[0]?.process
    const kill = vi.spyOn(process!, 'kill')

    adapter.cancel(session)

    expect(kill).toHaveBeenCalledOnce()
  })
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
