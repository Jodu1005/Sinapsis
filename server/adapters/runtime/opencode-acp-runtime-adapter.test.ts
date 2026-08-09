import { describe, expect, it } from 'vitest'
import { resolveRuntimeProfile } from './runtime-profile'
import { OpenCodeAcpRuntimeAdapter } from './opencode-acp-runtime-adapter'
import { FakeProcessRunner, type FakeProcessHandle } from '../../test/fake-process-runner'
import type { RuntimeEvent, RuntimeTaskRequest } from '../../ports/runtime'

const task: RuntimeTaskRequest = {
  taskId: 'task-1',
  mode: 'task',
  title: 'Implement the adapter',
  description: 'Use a worktree.',
  acceptanceCriteria: 'Tests pass.',
  worktreePath: '/tmp/task-1',
  profile: resolveRuntimeProfile('opencode-acp', { command: 'opencode-bin' }),
}

describe('OpenCodeAcpRuntimeAdapter', () => {
  it('drives OpenCode through ACP JSON-RPC and maps updates into runtime events', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeAcpRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]!.process
    expect(runner.spawns[0]?.options).toMatchObject({ command: 'opencode-bin', cwd: '/tmp/task-1', args: ['acp'] })

    const initialize = written(process, 0)
    expect(initialize).toMatchObject({ method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
    process.emitStdout(response(initialize.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }))
    await tick()

    const newSession = written(process, 1)
    expect(newSession).toMatchObject({ method: 'session/new', params: { cwd: '/tmp/task-1', mcpServers: [] } })
    process.emitStdout(response(newSession.id, { sessionId: 'ses-1' }))
    await tick()

    const prompt = written(process, 2)
    expect(prompt).toMatchObject({ method: 'session/prompt', params: { sessionId: 'ses-1' } })
    expect(JSON.stringify(prompt.params)).toContain('Completion is determined by the task result, not Git activity.')
    process.emitStdout(notification('session/update', { sessionId: 'ses-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我先修改文件。' } } }))
    process.emitStdout(notification('session/update', { sessionId: 'ses-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Edit file', status: 'pending' } }))
    process.emitStdout(notification('session/update', { sessionId: 'ses-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } }))
    process.emitStdout(notification('session/update', { sessionId: 'ses-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成实现，测试通过。' } } }))
    process.emitStdout(response(prompt.id, { stopReason: 'end_turn' }))
    await tick()

    expect(events).toEqual(expect.arrayContaining([
      { kind: 'session', taskId: task.taskId, sessionId: 'ses-1' },
      { kind: 'text', taskId: task.taskId, text: '已完成实现，测试通过。' },
      { kind: 'tool_start', taskId: task.taskId, toolName: 'Edit file', toolCallId: 'tool-1' },
      { kind: 'tool_end', taskId: task.taskId, toolName: 'Edit file', toolCallId: 'tool-1', success: true },
      { kind: 'settled', taskId: task.taskId },
    ]))
    expect(events.filter((event) => event.kind === 'settled')).toHaveLength(1)
    expect(events).not.toContainEqual({ kind: 'text', taskId: task.taskId, text: '我先修改文件。' })
  })

  it('selects ACP permission options automatically according to execution policy', async () => {
    const runner = new FakeProcessRunner()
    const adapter = new OpenCodeAcpRuntimeAdapter(runner)
    await adapter.start(task, () => {})
    const process = runner.spawns[0]!.process
    process.emitStdout(response(written(process, 0).id, { protocolVersion: 1, agentCapabilities: {} }))
    await tick()
    process.emitStdout(response(written(process, 1).id, { sessionId: 'ses-1' }))
    await tick()

    process.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'ses-1', options: [
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    ] } })}\n`)

    expect(written(process, 3)).toMatchObject({ id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
  })

  it('drops ACP history replay emitted while restoring a prior session', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeAcpRuntimeAdapter(runner)
    const resumedTask = { ...task, resumeSessionId: 'old-session' }

    const session = await adapter.start(resumedTask, (event) => events.push(event))
    session.sessionId = 'old-session'
    const process = runner.spawns[0]!.process
    process.emitStdout(response(written(process, 0).id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }))
    await tick()

    const resume = written(process, 1)
    expect(resume).toMatchObject({ method: 'session/resume', params: { sessionId: 'old-session' } })
    process.emitStdout(notification('session/update', { sessionId: 'old-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '上一轮旧回答' } } }))
    process.emitStdout(response(resume.id, { sessionId: 'old-session' }))
    await tick()

    const prompt = written(process, 2)
    process.emitStdout(notification('session/update', { sessionId: 'old-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '本轮新回答' } } }))
    process.emitStdout(response(prompt.id, { stopReason: 'end_turn' }))
    await tick()

    expect(events).toContainEqual({ kind: 'text', taskId: task.taskId, text: '本轮新回答' })
    expect(events).not.toContainEqual({ kind: 'text', taskId: task.taskId, text: '上一轮旧回答' })
  })

  it('falls back to the last response when a turn ends immediately after a tool call', async () => {
    const runner = new FakeProcessRunner()
    const events: RuntimeEvent[] = []
    const adapter = new OpenCodeAcpRuntimeAdapter(runner)

    await adapter.start(task, (event) => events.push(event))
    const process = runner.spawns[0]!.process
    process.emitStdout(response(written(process, 0).id, { protocolVersion: 1, agentCapabilities: {} }))
    await tick()
    process.emitStdout(response(written(process, 1).id, { sessionId: 'ses-1' }))
    await tick()

    const prompt = written(process, 2)
    process.emitStdout(notification('session/update', { sessionId: 'ses-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已经完成。' } } }))
    process.emitStdout(notification('session/update', { sessionId: 'ses-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Format', status: 'pending' } }))
    process.emitStdout(response(prompt.id, { stopReason: 'end_turn' }))
    await tick()

    expect(events).toContainEqual({ kind: 'text', taskId: task.taskId, text: '已经完成。' })
  })
})

function written(process: FakeProcessHandle, index: number): Record<string, unknown> {
  return JSON.parse(process.stdin[index] ?? '{}') as Record<string, unknown>
}

function response(id: unknown, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`
}

function notification(method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
