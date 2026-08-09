import { describe, expect, it, vi } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile'
import { PiRuntimeAdapter } from './pi-runtime-adapter'
import { FakeProcessRunner } from '../../test/fake-process-runner'
import type { RuntimeEvent, RuntimeTaskRequest } from '../../ports/runtime'

const task: RuntimeTaskRequest = {
  taskId: 'task-2',
  mode: 'task',
  title: 'Review pull request',
  description: 'Inspect the changes.',
  acceptanceCriteria: 'Leave a concise review.',
  worktreePath: '/tmp/task-2',
  profile: resolveRuntimeProfile('pi', { command: 'pi-bin' }),
}

describe('PiRuntimeAdapter', () => {
  it('starts a conversation with a read-only prompt containing channel context and the human message', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new PiRuntimeAdapter(runner, '/tmp/sinapsis-data')

    await adapter.start({
      ...task,
      mode: 'conversation',
      description: 'Recent channel context: the migration needs review.',
      initialMessage: 'Which risk should we address first?',
    }, () => {})
    const process = runner.spawns[0]?.process
    process?.emitStdout('{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-session-1"}}\n')

    const prompt = JSON.parse(process?.stdin[1] ?? '{}').message ?? ''
    expect(prompt).toContain('read-only')
    expect(prompt).toMatch(/do not edit/i)
    expect(prompt).toMatch(/do not commit/i)
    expect(prompt).toMatch(/do not push/i)
    expect(prompt).toMatch(/do not merge/i)
    expect(prompt).toContain('Recent channel context: the migration needs review.')
    expect(prompt).toContain('Which risk should we address first?')
  })

  it('enforces the read-only no-tools policy without loading profile resources or persisting a session', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new PiRuntimeAdapter(runner, '/tmp/sinapsis-data')

    await adapter.start({
      ...task,
      executionPolicy: 'read-only-no-tools',
      profile: resolveRuntimeProfile('pi', {
        command: 'pi-bin',
        args: ['--extension', '/tmp/evil.ts', '--skill', '/tmp/evil.md', '--tools', 'bash'],
      }),
    }, () => {})

    expect(runner.spawns[0]?.options.args).toEqual([
      '--mode', 'rpc',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-session',
      '--no-approve',
    ])
  })

  it('captures its session state before sending the initial prompt', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner, '/tmp/sinapsis-data')

    const session = await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]?.process

    expect(runner.spawns[0]?.options).toMatchObject({
      command: 'pi-bin',
      cwd: '/tmp/task-2',
      args: ['--mode', 'rpc', '--session-dir', '/tmp/sinapsis-data/pi-sessions', '--name', 'sinapsis:task-2'],
    })
    expect(JSON.parse(process?.stdin[0] ?? '{}')).toMatchObject({ type: 'get_state' })
    expect(process?.stdin).toHaveLength(1)

    process?.emitStdout('{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-session-1","sessionFile":"/tmp/pi-session.jsonl"}}\n')

    expect(JSON.parse(process?.stdin[1] ?? '{}')).toMatchObject({
      type: 'prompt',
      message: expect.stringContaining('Do not create a branch or commit unless the task explicitly asks for one.'),
    })
    expect(session).toMatchObject({ sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session.jsonl' })
  })

  it('buffers human input until a resumed session has switched successfully', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    const firstProcess = runner.spawns[0]?.process
    firstProcess?.emitStdout('{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-session-1","sessionFile":"/tmp/pi-session.jsonl"}}\n')
    firstProcess?.emitStdout('{"type":"agent_settled"}\n')

    await adapter.resume(session, (event) => events.push(event))
    const resumedProcess = runner.spawns[1]?.process

    expect(JSON.parse(resumedProcess?.stdin[0] ?? '{}')).toMatchObject({ type: 'switch_session', sessionPath: '/tmp/pi-session.jsonl' })

    adapter.sendInput(session, 'Check the migration too.', (event) => events.push(event))
    expect(resumedProcess?.stdin).toHaveLength(1)

    resumedProcess?.emitStdout('{"type":"response","command":"switch_session","success":true}\n')

    expect(JSON.parse(resumedProcess?.stdin[1] ?? '{}')).toMatchObject({ type: 'prompt', message: 'Check the migration too.' })
  })

  it('uses RPC prompt and steer commands, then emits settled from agent_settled', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]?.process
    process?.emitStdout('{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi-session-1","sessionFile":"/tmp/pi-session.jsonl"}}\n')

    adapter.sendInput(session, 'Focus on security.', (event) => events.push(event))
    expect(JSON.parse(process?.stdin[2] ?? '{}')).toMatchObject({ type: 'steer', message: 'Focus on security.' })

    process?.emitStdout('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Found one issue."}}\n')
    process?.emitStdout('{"type":"tool_execution_start","toolName":"git","toolCallId":"call-1"}\n')
    process?.emitStdout('{"type":"queue_update","steering":["Follow the branch"],"followUp":["Run tests"]}\n')
    process?.emitStdout('{"type":"agent_settled"}\n')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'text', text: 'Found one issue.' }),
      expect.objectContaining({ kind: 'tool_start', toolName: 'git' }),
      expect.objectContaining({ kind: 'queue', queueLength: 2 }),
      expect.objectContaining({ kind: 'settled' }),
    ]))
    expect(session.isStreaming).toBe(false)
    expect(session).toMatchObject({ sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session.jsonl' })
  })

  it('does not expose Pi thinking updates as assistant text', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]?.process
    process?.emitStdout('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"private reasoning"}}\n')
    process?.emitStdout('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"public reply"}}\n')

    expect(events).toContainEqual(expect.objectContaining({ kind: 'text', text: 'public reply' }))
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'text', text: 'private reasoning' }))
  })

  it('surfaces failed Pi RPC responses instead of leaving the task marked as running', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    runner.spawns[0]?.process.emitStdout('{"id":"1","type":"response","command":"get_state","success":false,"error":"Unknown command"}\n')

    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', message: 'Unknown command' }))
  })

  it('classifies failed switch_session responses as session_lost', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)
    const session = {
      ...task,
      runtime: 'pi' as const,
      sessionId: 'pi-session-1',
      sessionFile: '/tmp/missing-pi-session.jsonl',
      isStreaming: false,
      queueLength: 0,
      pendingInputs: [],
    }

    await adapter.resume(session, (event) => events.push(event))
    runner.spawns[0]?.process.emitStdout('{"type":"response","command":"switch_session","success":false,"error":"Session not found"}\n')

    expect(events).toContainEqual({
      kind: 'error',
      taskId: task.taskId,
      message: 'Session not found',
      errorCode: 'session_lost',
    })
  })

  it('cancels its managed process for a session', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new PiRuntimeAdapter(runner, '/tmp/sinapsis-data')
    const session = await adapter.start(task, () => {})
    const process = runner.spawns[0]?.process
    const kill = vi.spyOn(process!, 'kill')

    adapter.cancel(session)

    expect(kill).toHaveBeenCalledOnce()
  })
})
