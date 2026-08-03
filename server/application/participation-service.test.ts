import { describe, expect, it } from 'vitest'
import { FakeRuntimeAdapter } from '../adapters/runtime/fake-runtime-adapter'
import type { RuntimeTaskRequest } from '../ports/runtime'
import { ParticipationService } from './participation-service'

describe('ParticipationService', () => {
  it('returns the parsed decision from a participation probe', async () => {
    const service = new ParticipationService({
      participationProbeTimeoutMs: 50,
      invoke: async () => '{"decision":"speak","confidence":0.9,"reason":"frontend responsibility","proposedAngle":"inspect the form","dependsOnAgentId":null}',
    })

    await expect(service.decide({
      candidateAgentIds: ['a1'],
      candidateResponsibilities: ['frontend'],
      currentMessage: 'The form does not submit.',
      channelSummary: 'Checkout reports.',
    })).resolves.toEqual({
      decision: 'speak',
      confidence: 0.9,
      reason: 'frontend responsibility',
      proposedAngle: 'inspect the form',
      dependsOnAgentId: null,
    })
  })

  it('passes valid candidate IDs into the participation probe prompt', async () => {
    const service = new ParticipationService({
      participationProbeTimeoutMs: 50,
      invoke: async (call) => {
        expect(call.prompt).toContain('a1')
        expect(call.prompt).toContain('a2')
        expect(call.prompt).toContain('dependsOnAgentId must be null or exactly one ID from this list')
        return '{"decision":"silent","confidence":0,"reason":"not relevant","proposedAngle":"","dependsOnAgentId":null}'
      },
    })

    await service.decide({
      candidateAgentIds: ['a1', 'a2'],
      candidateResponsibilities: ['frontend'],
      currentMessage: 'The form does not submit.',
      channelSummary: 'Checkout reports.',
    })
  })

  it('returns the minimal timeout fallback without preventing another candidate from deciding', async () => {
    const service = new ParticipationService({
      participationProbeTimeoutMs: 10,
      invoke: async (call) => call.prompt.includes('Candidate responsibilities:\n- slow')
        ? new Promise<string>(() => undefined)
        : '{"decision":"silent","confidence":0.1,"reason":"not relevant","proposedAngle":"","dependsOnAgentId":null}',
    })

    const [timedOut, completed] = await Promise.all([
      service.decide({ candidateAgentIds: ['slow', 'fast'], candidateResponsibilities: ['slow'], currentMessage: 'Question', channelSummary: 'Summary' }),
      service.decide({ candidateAgentIds: ['slow', 'fast'], candidateResponsibilities: ['fast'], currentMessage: 'Question', channelSummary: 'Summary' }),
    ])

    expect(timedOut).toEqual({ decision: 'silent', reason: 'timeout' })
    expect(completed).toEqual({ decision: 'silent', confidence: 0.1, reason: 'not relevant', proposedAngle: '', dependsOnAgentId: null })
  })

  it('preserves optional conversation metadata in fake runtime starts', async () => {
    const runtime = new FakeRuntimeAdapter()
    const request: RuntimeTaskRequest = {
      taskId: 'task-1',
      mode: 'conversation',
      title: 'Conversation',
      description: 'Context',
      acceptanceCriteria: 'Reply',
      worktreePath: '/tmp/worktree',
      profile: { runtime: 'pi', command: 'pi', args: [], model: '', env: {}, policy: 'task-worktree' },
      conversation: { turnId: 'turn-1', invocationId: 'invocation-1', kind: 'participation', expectedOutput: 'participation' },
    }

    await runtime.start(request, () => undefined)

    expect(runtime.starts[0]?.conversation).toEqual(request.conversation)
  })
})
