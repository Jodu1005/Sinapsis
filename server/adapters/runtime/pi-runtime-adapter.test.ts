import { describe, expect, it } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile'
import { PiRuntimeAdapter } from './pi-runtime-adapter'
import { FakeProcessRunner } from '../../test/fake-process-runner'
import type { RuntimeEvent, RuntimeTaskRequest } from '../../ports/runtime'

const task: RuntimeTaskRequest = {
  taskId: 'task-2',
  title: 'Review pull request',
  description: 'Inspect the changes.',
  acceptanceCriteria: 'Leave a concise review.',
  worktreePath: '/tmp/task-2',
  profile: resolveRuntimeProfile('pi', { command: 'pi-bin' }),
}

describe('PiRuntimeAdapter', () => {
  it('captures its session state before sending the initial prompt', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]?.process

    expect(runner.spawns[0]?.options).toMatchObject({
      command: 'pi-bin',
      cwd: '/tmp/task-2',
      args: ['--mode', 'rpc'],
    })
    expect(JSON.parse(process?.stdin[0] ?? '{}')).toMatchObject({ command: 'get_state' })
    expect(process?.stdin).toHaveLength(1)

    process?.emitStdout('{"type":"response","command":"get_state","success":true,"result":{"sessionId":"pi-session-1","sessionFile":"/tmp/pi-session.jsonl"}}\n')

    expect(JSON.parse(process?.stdin[1] ?? '{}')).toMatchObject({ command: 'prompt' })
    expect(session).toMatchObject({ sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session.jsonl' })
  })

  it('buffers human input until a resumed session has switched successfully', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    const firstProcess = runner.spawns[0]?.process
    firstProcess?.emitStdout('{"type":"response","command":"get_state","success":true,"result":{"sessionId":"pi-session-1","sessionFile":"/tmp/pi-session.jsonl"}}\n')
    firstProcess?.emitStdout('{"type":"agent_settled"}\n')

    await adapter.resume(session, (event) => events.push(event))
    const resumedProcess = runner.spawns[1]?.process

    expect(JSON.parse(resumedProcess?.stdin[0] ?? '{}')).toMatchObject({
      command: 'switch_session',
      args: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session.jsonl' },
    })

    adapter.sendInput(session, 'Check the migration too.', (event) => events.push(event))
    expect(resumedProcess?.stdin).toHaveLength(1)

    resumedProcess?.emitStdout('{"type":"response","command":"switch_session","success":true}\n')

    expect(JSON.parse(resumedProcess?.stdin[1] ?? '{}')).toMatchObject({
      command: 'prompt',
      args: { text: 'Check the migration too.' },
    })
  })

  it('uses RPC prompt and steer commands, then emits settled from agent_settled', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new PiRuntimeAdapter(runner)

    const session = await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]?.process
    process?.emitStdout('{"type":"response","command":"get_state","success":true,"result":{"sessionId":"pi-session-1","sessionFile":"/tmp/pi-session.jsonl"}}\n')

    adapter.sendInput(session, 'Focus on security.', (event) => events.push(event))
    expect(JSON.parse(process?.stdin[2] ?? '{}')).toMatchObject({ command: 'steer', args: { text: 'Focus on security.' } })

    process?.emitStdout('{"type":"message_update","delta":{"text_delta":"Found one issue."}}\n')
    process?.emitStdout('{"type":"tool_execution_start","tool_name":"git","tool_call_id":"call-1"}\n')
    process?.emitStdout('{"type":"queue_update","queue_length":2}\n')
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
})
