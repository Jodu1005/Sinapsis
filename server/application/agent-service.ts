import {
  type RuntimeProfileOverrides,
} from '../adapters/runtime/runtime-profile'
import type { RuntimeAvailability, RuntimeAvailabilityDetector, RuntimeKind, RuntimeProfile } from '../ports/runtime-profile'
import { RuntimeProfileService } from './runtime-profile-service'
import { NotFoundError, ValidationError } from './workspace-service'
import { DomainError } from '../domain/task'
import type { Agent, AgentStatus } from '../domain/agent'

export interface AgentCatalog {
  hasAgentMention(mention: string): boolean
  getAgent(agentId: string): Agent | undefined
  createAgent(input: {
    identity: string
    mentionName: string
    runtime: RuntimeKind
    capabilityTags: string[]
    responsibilities?: string[]
    maxConcurrentTasks: 1
    command: string
    args: string[]
    model: string
    env: Record<string, string>
  }): { id: string; createdAt: string }
  setAgentStatus?(agentId: string, status: AgentStatus, occurredAt: Date): unknown
}

export interface AgentConfiguration {
  id: string
  identity: string
  mention: string
  runtime: RuntimeKind
  capabilityTags: string[]
  responsibilities: string[]
  maxConcurrentTasks: 1
  profile: RuntimeProfile
  availability: RuntimeAvailability
  createdAt: string
}

export interface CreateAgentInput {
  identity: string
  mention: string
  runtime: RuntimeKind
  capabilityTags: string[]
  responsibilities?: string[]
  runtimeOverrides?: RuntimeProfileOverrides
}

export class AgentService {
  private readonly profiles = new RuntimeProfileService()

  constructor(
    private readonly agents: AgentCatalog,
    private readonly availabilityDetector: RuntimeAvailabilityDetector,
  ) {}

  async createAgent(input: CreateAgentInput): Promise<AgentConfiguration> {
    const mention = requiredMention(input.mention)
    if (this.agents.hasAgentMention(mention)) {
      throw new DomainError(`Agent mention @${mention} already exists globally.`)
    }

    const profile = this.profiles.resolve(input.runtime, input.runtimeOverrides)
    const availability = await this.availabilityDetector.detect(profile)
    let storedAgent: { id: string; createdAt: string }
    try {
      storedAgent = this.agents.createAgent({
        identity: requiredText(input.identity, 'Agent identity'),
        mentionName: mention,
        runtime: input.runtime,
        capabilityTags: input.capabilityTags.map((tag) => requiredText(tag, 'Capability tag')),
        responsibilities: (input.responsibilities ?? []).map((responsibility) => requiredText(responsibility, 'Agent responsibility')),
        maxConcurrentTasks: 1,
        command: profile.command,
        args: profile.args,
        model: profile.model,
        env: profile.env,
      })
    } catch (error) {
      if (isMentionUniqueConstraint(error)) {
        throw new DomainError(`Agent mention @${mention} already exists globally.`)
      }
      throw error
    }
    if (availability.executable === 'available' && availability.taskExecution === 'unverified') {
      this.agents.setAgentStatus?.(storedAgent.id, 'idle', new Date())
    }
    return {
      id: storedAgent.id,
      identity: requiredText(input.identity, 'Agent identity'),
      mention,
      runtime: input.runtime,
      capabilityTags: input.capabilityTags.map((tag) => requiredText(tag, 'Capability tag')),
      responsibilities: (input.responsibilities ?? []).map((responsibility) => requiredText(responsibility, 'Agent responsibility')),
      maxConcurrentTasks: 1,
      profile,
      availability,
      createdAt: storedAgent.createdAt,
    }
  }

  async refreshAvailability(agentId: string): Promise<Agent> {
    const agent = this.agents.getAgent(agentId)
    if (!agent) throw new NotFoundError(`Agent ${agentId} does not exist.`)

    const availability = await this.availabilityDetector.detect(profileFromAgent(agent))
    if (agent.status === 'busy') return agent

    const nextStatus = availability.executable === 'available' && availability.taskExecution === 'unverified'
      ? 'idle'
      : 'offline'
    if (nextStatus === agent.status) return agent

    const updated = this.agents.setAgentStatus?.(agent.id, nextStatus, new Date()) as Agent | undefined
    return updated ?? {
      ...agent,
      status: nextStatus,
    }
  }
}

function profileFromAgent(agent: Agent): RuntimeProfile {
  return {
    runtime: agent.runtime,
    command: agent.command,
    args: agent.args,
    model: agent.model,
    env: agent.env,
    policy: 'task-worktree',
  }
}

function requiredMention(value: string): string {
  const rawMention = requiredText(value, 'Agent mention')
  const mention = rawMention.startsWith('@') ? rawMention.slice(1) : rawMention
  if (!mention) throw new ValidationError('Agent mention is required.')
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(mention)) {
    throw new ValidationError('Agent mention must contain only letters, numbers, hyphens, or underscores.')
  }
  return mention.toLowerCase()
}

function isMentionUniqueConstraint(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('UNIQUE constraint failed')
    && (error.message.includes('agents_mention_name_unique_idx') || error.message.includes('agents.mention_name'))
}

function requiredText(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new ValidationError(`${name} is required.`)
  return trimmed
}
