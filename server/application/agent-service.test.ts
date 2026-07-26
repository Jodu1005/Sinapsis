import { describe, expect, it, vi } from 'vitest'
import { AgentService } from './agent-service'
import { resolveRuntimeProfile, type RuntimeAvailabilityDetector } from '../adapters/runtime/runtime-profile'
import type { Agent, AgentStatus } from '../domain/agent'

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
      availability: { executable: 'available', taskExecution: 'unverified' },
    })
    expect(repository.createdAgents).toContainEqual(expect.objectContaining({
      workspaceId: 'workspace-1',
      identity: 'Build engineer',
      mentionName: 'build',
      maxConcurrentTasks: 1,
    }))
    expect(repository.statusUpdates).toEqual([
      expect.objectContaining({ agentId: 'agent-1', status: 'idle' }),
    ])
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

  it('resolves the claude code runtime preset for local task worktrees', () => {
    expect(resolveRuntimeProfile('claude-code')).toEqual({
      runtime: 'claude-code',
      command: 'claude',
      args: [],
      model: '',
      env: {},
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

  it('normalizes one optional at prefix and rejects ambiguous or invalid mention names', async () => {
    const repository = new RecordingAgentRepository(['workspace-1'])
    const service = new AgentService(repository, availableDetector())

    const agent = await service.createAgent({
      workspaceId: 'workspace-1', identity: 'Build engineer', mention: ' @Build ', runtime: 'opencode', capabilityTags: [],
    })

    expect(agent.mention).toBe('build')
    expect(repository.createdAgents[0]).toMatchObject({ mentionName: 'build' })
    await expect(service.createAgent({
      workspaceId: 'workspace-1', identity: 'Second engineer', mention: '@@build', runtime: 'opencode', capabilityTags: [],
    })).rejects.toThrow('Agent mention must contain only letters, numbers, hyphens, or underscores.')
    await expect(service.createAgent({
      workspaceId: 'workspace-1', identity: 'Third engineer', mention: 'build/name', runtime: 'opencode', capabilityTags: [],
    })).rejects.toThrow('Agent mention must contain only letters, numbers, hyphens, or underscores.')
  })

  it('refreshes an offline Agent back to idle when its persisted runtime is available', async () => {
    const detector = availableDetector()
    const repository = new RecordingAgentRepository(['workspace-1'])
    const stored = repository.seedAgent({ id: 'agent-refresh', status: 'offline' })
    const service = new AgentService(repository, detector)

    const refreshed = await service.refreshAvailability(stored.id)

    expect(detector.detect).toHaveBeenCalledWith(expect.objectContaining({
      runtime: 'opencode',
      command: 'opencode',
      args: ['run'],
      env: { API_TOKEN: 'secret' },
    }))
    expect(refreshed.status).toBe('idle')
    expect(repository.statusUpdates).toEqual([
      expect.objectContaining({ agentId: stored.id, status: 'idle' }),
    ])
  })

  it.each([
    [{ executable: 'missing', taskExecution: 'unavailable' }, 'idle'],
    [{ executable: 'available', taskExecution: 'unhealthy' }, 'error'],
  ] as const)('refreshes a non-busy Agent to offline when runtime health is %j', async (availability, initialStatus) => {
    const repository = new RecordingAgentRepository(['workspace-1'])
    const stored = repository.seedAgent({ id: `agent-${initialStatus}`, status: initialStatus })
    const service = new AgentService(repository, detectorWith(availability))

    const refreshed = await service.refreshAvailability(stored.id)

    expect(refreshed.status).toBe('offline')
    expect(repository.statusUpdates).toEqual([
      expect.objectContaining({ agentId: stored.id, status: 'offline' }),
    ])
  })

  it('never changes a busy Agent status during runtime refresh', async () => {
    const repository = new RecordingAgentRepository(['workspace-1'])
    const stored = repository.seedAgent({ id: 'agent-busy', status: 'busy' })
    const service = new AgentService(repository, detectorWith({ executable: 'missing', taskExecution: 'unavailable' }))

    const refreshed = await service.refreshAvailability(stored.id)

    expect(refreshed.status).toBe('busy')
    expect(repository.statusUpdates).toEqual([])
  })
})

function availableDetector(): RuntimeAvailabilityDetector & { detect: ReturnType<typeof vi.fn> } {
  return detectorWith({ executable: 'available', taskExecution: 'unverified' })
}

function detectorWith(availability: { executable: 'available' | 'missing'; taskExecution: 'unverified' | 'unhealthy' | 'unavailable' }) {
  return {
    detect: vi.fn().mockResolvedValue(availability),
  }
}

class RecordingAgentRepository {
  readonly createdAgents: Array<Record<string, unknown>> = []
  readonly statusUpdates: Array<{ agentId: string; status: string }> = []
  readonly agents = new Map<string, Agent>()

  constructor(private readonly workspaceIds: string[]) {}

  hasWorkspace(workspaceId: string): boolean {
    return this.workspaceIds.includes(workspaceId)
  }

  hasAgentMention(workspaceId: string, mention: string): boolean {
    return this.createdAgents.some((agent) => agent.workspaceId === workspaceId && agent.mentionName === mention)
  }

  createAgent(input: Record<string, unknown>) {
    this.createdAgents.push(input)
    const id = `agent-${this.createdAgents.length}`
    const createdAt = '2026-07-25T00:00:00.000Z'
    this.agents.set(id, {
      id,
      workspaceId: input.workspaceId as string,
      identity: input.identity as string,
      mentionName: input.mentionName as string,
      runtime: input.runtime as Agent['runtime'],
      status: 'offline',
      capabilityTags: input.capabilityTags as string[],
      maxConcurrentTasks: 1,
      command: input.command as string,
      args: input.args as string[],
      model: input.model as string,
      env: input.env as Record<string, string>,
      createdAt,
      updatedAt: createdAt,
    })
    return { id, createdAt }
  }

  setAgentStatus(agentId: string, status: string) {
    this.statusUpdates.push({ agentId, status })
    const agent = this.agents.get(agentId)
    if (agent) {
      this.agents.set(agentId, { ...agent, status: status as AgentStatus, updatedAt: '2026-07-25T00:01:00.000Z' })
    }
  }

  getAgent(agentId: string) {
    return this.agents.get(agentId)
  }

  seedAgent(overrides: { id: string; status: AgentStatus }) {
    const agent: Agent = {
      id: overrides.id,
      workspaceId: 'workspace-1',
      identity: 'Build engineer',
      mentionName: 'build',
      runtime: 'opencode',
      status: overrides.status,
      capabilityTags: ['typescript'],
      maxConcurrentTasks: 1,
      command: 'opencode',
      args: ['run'],
      model: '',
      env: { API_TOKEN: 'secret' },
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }
    this.agents.set(agent.id, agent)
    return agent
  }
}
