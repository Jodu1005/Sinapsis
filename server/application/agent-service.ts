import {
  type RuntimeAvailability,
  type RuntimeAvailabilityDetector,
  type RuntimeKind,
  type RuntimeProfile,
  type RuntimeProfileOverrides,
} from '../adapters/runtime/runtime-profile'
import { RuntimeProfileService } from './runtime-profile-service'
import { NotFoundError, ValidationError } from './workspace-service'
import { DomainError } from '../domain/task'

export interface AgentWorkspaceReader {
  hasWorkspace(workspaceId: string): boolean
  hasAgentMention(workspaceId: string, mention: string): boolean
  createAgent(input: {
    workspaceId: string
    identity: string
    mentionName: string
    runtime: RuntimeKind
    capabilityTags: string[]
    maxConcurrentTasks: 1
    command: string
    args: string[]
    model: string
    env: Record<string, string>
  }): { id: string; createdAt: string }
}

export interface AgentConfiguration {
  id: string
  workspaceId: string
  identity: string
  mention: string
  runtime: RuntimeKind
  capabilityTags: string[]
  maxConcurrentTasks: 1
  profile: RuntimeProfile
  availability: RuntimeAvailability
  createdAt: string
}

export interface CreateAgentInput {
  workspaceId: string
  identity: string
  mention: string
  runtime: RuntimeKind
  capabilityTags: string[]
  runtimeOverrides?: RuntimeProfileOverrides
}

export class AgentService {
  private readonly profiles = new RuntimeProfileService()

  constructor(
    private readonly workspaces: AgentWorkspaceReader,
    private readonly availabilityDetector: RuntimeAvailabilityDetector,
  ) {}

  async createAgent(input: CreateAgentInput): Promise<AgentConfiguration> {
    if (!this.workspaces.hasWorkspace(input.workspaceId)) {
      throw new NotFoundError(`Workspace ${input.workspaceId} does not exist.`)
    }

    const mention = requiredMention(input.mention)
    if (this.workspaces.hasAgentMention(input.workspaceId, mention)) {
      throw new DomainError(`Agent mention @${mention} already exists in this workspace.`)
    }

    const profile = this.profiles.resolve(input.runtime, input.runtimeOverrides)
    const availability = await this.availabilityDetector.detect(profile)
    const storedAgent = this.workspaces.createAgent({
      workspaceId: input.workspaceId,
      identity: requiredText(input.identity, 'Agent identity'),
      mentionName: mention,
      runtime: input.runtime,
      capabilityTags: input.capabilityTags.map((tag) => requiredText(tag, 'Capability tag')),
      maxConcurrentTasks: 1,
      command: profile.command,
      args: profile.args,
      model: profile.model,
      env: profile.env,
    })
    return {
      id: storedAgent.id,
      workspaceId: input.workspaceId,
      identity: requiredText(input.identity, 'Agent identity'),
      mention,
      runtime: input.runtime,
      capabilityTags: input.capabilityTags.map((tag) => requiredText(tag, 'Capability tag')),
      maxConcurrentTasks: 1,
      profile,
      availability,
      createdAt: storedAgent.createdAt,
    }
  }
}

function requiredMention(value: string): string {
  const mention = requiredText(value, 'Agent mention').replace(/^@/, '')
  if (!mention) throw new ValidationError('Agent mention is required.')
  return mention
}

function requiredText(value: string, name: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new ValidationError(`${name} is required.`)
  return trimmed
}
