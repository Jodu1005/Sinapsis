import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service'
import { resolveRuntimeProfile, type RuntimeAvailabilityDetector } from '../adapters/runtime/runtime-profile'

describe('AgentService', () => {
  it('requires an existing workspace and fixes agent concurrency to one', async () => {
    const repository = new RecordingAgentRepository(['workspace-1'])
    const service = new AgentService(repository, availableDetector())

    const agent = await service.createAgent({
      workspaceId: 'workspace-1',
      identity: 'Build engineer',
      mention: 'build',
      runtime: 'opencode',
      capabilityTags: ['typescript'],
    })

    expect(agent).toMatchObject({
      workspaceId: 'workspace-1',
      identity: 'Build engineer',
      mention: 'build',
      maxConcurrentTasks: 1,
      runtime: 'opencode',
      capabilityTags: ['typescript'],
      availability: { executable: 'available', taskExecution: 'ready' },
    })
    expect(repository.createdAgents).toContainEqual(expect.objectContaining({
      workspaceId: 'workspace-1',
      identity: 'Build engineer',
      mentionName: 'build',
      maxConcurrentTasks: 1,
    }))
  })

  it('rejects an Agent whose workspace does not exist', async () => {
    const service = new AgentService(new RecordingAgentRepository([]), availableDetector())

    await expect(service.createAgent({
      workspaceId: 'missing-workspace', identity: 'Build engineer', mention: 'build', runtime: 'opencode', capabilityTags: [],
    })).rejects.toThrow('Workspace missing-workspace does not exist.')
  })

  it('rejects a duplicate mention inside one workspace', async () => {
    const service = new AgentService(new RecordingAgentRepository(['workspace-1']), availableDetector())
    const input = { workspaceId: 'workspace-1', identity: 'Build engineer', mention: 'build', runtime: 'opencode' as const, capabilityTags: [] }

    await service.createAgent(input)

    await expect(service.createAgent({ ...input, identity: 'Another engineer' })).rejects.toThrow('Agent mention @build already exists in this workspace.')
  })

  it('merges overrides into a runtime preset without dropping preset fields', () => {
    expect(resolveRuntimeProfile('opencode', {
      command: 'custom-opencode',
      env: { OPENAI_API_KEY: 'secret' },
    })).toEqual({
      runtime: 'opencode',
      command: 'custom-opencode',
      args: ['run'],
      model: '',
      env: { OPENAI_API_KEY: 'secret' },
      policy: 'task-worktree',
    })
  })

  it('probes the resolved runtime profile before storing the Agent configuration', async () => {
    const detector = availableDetector()
    const service = new AgentService(new RecordingAgentRepository(['workspace-1']), detector)

    await service.createAgent({
      workspaceId: 'workspace-1', identity: 'Pi engineer', mention: 'pi', runtime: 'pi', capabilityTags: [],
      runtimeOverrides: { command: 'pi-local' },
    })

    expect(detector.detect).toHaveBeenCalledWith(expect.objectContaining({ command: 'pi-local', args: ['--mode', 'rpc'] }))
  })
})

function availableDetector(): RuntimeAvailabilityDetector & { detect: ReturnType<typeof vi.fn> } {
  return {
    detect: vi.fn().mockResolvedValue({ executable: 'available', taskExecution: 'ready' }),
  }
}

class RecordingAgentRepository {
  readonly createdAgents: Array<Record<string, unknown>> = []

  constructor(private readonly workspaceIds: string[]) {}

  hasWorkspace(workspaceId: string): boolean {
    return this.workspaceIds.includes(workspaceId)
  }

  hasAgentMention(workspaceId: string, mention: string): boolean {
    return this.createdAgents.some((agent) => agent.workspaceId === workspaceId && agent.mentionName === mention)
  }

  createAgent(input: Record<string, unknown>) {
    this.createdAgents.push(input)
    return { id: `agent-${this.createdAgents.length}`, createdAt: '2026-07-25T00:00:00.000Z' }
  }
}
