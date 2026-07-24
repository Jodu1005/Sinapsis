import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express'
import path from 'node:path'
import { CommandGitClient } from './adapters/git/git-client'
import { GitWorktreeManager } from './adapters/git/git-worktree-manager'
import { OpenCodeRuntimeAdapter } from './adapters/runtime/opencode-runtime-adapter'
import { PiRuntimeAdapter } from './adapters/runtime/pi-runtime-adapter'
import { CommandRuntimeAvailabilityDetector, runtimeKinds, type RuntimeAvailabilityDetector } from './adapters/runtime/runtime-profile'
import { SseDomainEventPublisher } from './adapters/sse/sse-domain-event-publisher'
import { createSqliteDatabase } from './adapters/sqlite/database'
import { SqliteRepositories } from './adapters/sqlite/sqlite-repositories'
import { AgentService } from './application/agent-service'
import { ChannelMessageService } from './application/channel-message-service'
import { TaskExecutionCoordinator } from './application/task-execution-coordinator'
import { TaskReviewService } from './application/task-review-service'
import { TaskScheduler } from './application/task-scheduler'
import { TaskService } from './application/task-service'
import { NotFoundError, ValidationError, WorkspaceService, type WorkspaceCatalog, type WorkspaceMutationCatalog } from './application/workspace-service'
import { getServiceConfig } from './config'
import { DomainError } from './domain/task'
import type { GitClient } from './ports/git-client'
import { NodeProcessRunner } from './ports/process-runner'
import type { WorkspaceRepositories, WorkspaceUnitOfWork } from './ports/repositories'

export interface CreateAppOptions {
  databasePath?: string
  gitClient?: GitClient
  runtimeAvailabilityDetector?: RuntimeAvailabilityDetector
  executionCoordinator?: TaskExecutionCoordinator
  scheduler?: TaskScheduler
  reviewService?: TaskReviewService
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express()
  const databasePath = options.databasePath ?? defaultDatabasePath()
  const database = createSqliteDatabase(databasePath)
  const eventPublisher = new SseDomainEventPublisher()
  const repositories = new SqliteRepositories(database, eventPublisher)
  const catalog = new RepositoryWorkspaceCatalog(repositories)
  const workspaceService = new WorkspaceService(catalog, options.gitClient ?? new CommandGitClient())
  const agentService = new AgentService(catalog, options.runtimeAvailabilityDetector ?? new CommandRuntimeAvailabilityDetector())
  const taskService = new TaskService(repositories)
  const messages = new ChannelMessageService(repositories)
  const coordinator = options.executionCoordinator ?? new TaskExecutionCoordinator({
    repositories,
    runtimes: {
      opencode: new OpenCodeRuntimeAdapter(new NodeProcessRunner()),
      pi: new PiRuntimeAdapter(new NodeProcessRunner()),
    },
    worktrees: new GitWorktreeManager({ dataDir: path.dirname(databasePath) }),
    artifactDirectory: path.join(path.dirname(databasePath), 'artifacts'),
    messages,
  })
  const scheduler = options.scheduler ?? new TaskScheduler(repositories, coordinator)
  const reviewService = options.reviewService ?? new TaskReviewService(repositories, coordinator, messages)

  app.locals.closeDatabase = () => database.close()
  app.locals.closeSse = () => eventPublisher.close()
  app.locals.repositories = repositories
  app.locals.scheduler = scheduler
  app.locals.executionCoordinator = coordinator
  app.use(express.json())

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' })
  })

  app.get('/api/bootstrap', (_request, response) => {
    response.json(sanitizeBootstrap(repositories.getBootstrap()))
  })

  app.post('/api/workspaces', asyncRoute((request, response) => {
    const body = objectBody(request.body)
    assertOnlyKeys(body, ['name', 'leaseTtlMs'])
    const workspace = workspaceService.createWorkspace({
      name: requiredString(body, 'name'), leaseTtlMs: optionalPositiveInteger(body, 'leaseTtlMs'),
    })
    response.status(201).json(workspace)
  }))

  app.post('/api/workspaces/:workspaceId/repositories', asyncRoute(async (request, response) => {
    const body = objectBody(request.body)
    const repository = await workspaceService.addRepository({
      workspaceId: requiredParam(request.params.workspaceId, 'workspaceId'),
      directory: requiredString(body, 'directory'),
      name: optionalString(body, 'name'),
    })
    response.status(201).json(repository)
  }))

  app.post('/api/repositories/:repositoryId/channels', asyncRoute((request, response) => {
    const body = objectBody(request.body)
    const channel = workspaceService.createChannel({
      repositoryId: requiredParam(request.params.repositoryId, 'repositoryId'),
      name: requiredString(body, 'name'),
    })
    response.status(201).json(channel)
  }))

  app.post('/api/workspaces/:workspaceId/agents', asyncRoute(async (request, response) => {
    const body = objectBody(request.body)
    const runtime = requiredString(body, 'runtime')
    if (!runtimeKinds.includes(runtime as (typeof runtimeKinds)[number])) {
      throw new ValidationError('Runtime must be opencode or pi.')
    }
    const agent = await agentService.createAgent({
      workspaceId: requiredParam(request.params.workspaceId, 'workspaceId'),
      identity: requiredString(body, 'identity'),
      mention: requiredString(body, 'mention'),
      runtime: runtime as (typeof runtimeKinds)[number],
      capabilityTags: requiredStringArray(body, 'capabilityTags'),
      runtimeOverrides: runtimeOverrides(body),
    })
    response.status(201).json({
      ...agent,
      profile: { ...agent.profile, env: Object.keys(agent.profile.env) },
    })
  }))

  app.post('/api/repositories/:repositoryId/tasks', asyncRoute((request, response) => {
    const body = objectBody(request.body)
    assertOnlyKeys(body, ['title', 'description', 'acceptanceCriteria', 'labels', 'directAgentId', 'timeoutMs', 'leaseTtlMs', 'maxRetries'])
    const task = taskService.createTask({
      repositoryId: requiredParam(request.params.repositoryId, 'repositoryId'),
      title: requiredString(body, 'title'),
      description: requiredString(body, 'description'),
      acceptanceCriteria: requiredString(body, 'acceptanceCriteria'),
      labels: body.labels === undefined ? undefined : requiredStringArray(body, 'labels'),
      directAgentId: optionalString(body, 'directAgentId'),
      timeoutMs: optionalPositiveInteger(body, 'timeoutMs'),
      leaseTtlMs: optionalPositiveInteger(body, 'leaseTtlMs'),
      maxRetries: optionalNonNegativeInteger(body, 'maxRetries'),
    })
    response.status(201).json(task)
  }))

  app.get('/api/repositories/:repositoryId/tasks', asyncRoute((request, response) => {
    response.json(taskService.listTasks(requiredParam(request.params.repositoryId, 'repositoryId')))
  }))

  app.get('/api/tasks/:taskId', asyncRoute((request, response) => {
    const details = taskService.getTaskDetails(requiredParam(request.params.taskId, 'taskId'))
    response.json({
      ...details,
      artifacts: details.artifacts.map(({ path: _path, ...artifact }) => artifact),
    })
  }))

  app.post('/api/tasks/:taskId/input', asyncRoute((request, response) => {
    const body = objectBody(request.body)
    assertOnlyKeys(body, ['body'])
    const input = taskService.queueHumanInput(requiredParam(request.params.taskId, 'taskId'), requiredString(body, 'body'))
    coordinator.deliverQueuedInput(input.taskId, input.id)
    response.status(201).json(input)
  }))

  app.post('/api/channels/:channelId/messages', asyncRoute(async (request, response) => {
    const body = objectBody(request.body)
    assertOnlyKeys(body, ['body', 'taskId'])
    const channelId = requiredParam(request.params.channelId, 'channelId')
    const taskId = optionalString(body, 'taskId')
    const message = messages.postHuman(channelId, requiredString(body, 'body'), taskId)
    const mention = findMentionedAgent(repositories, channelId, message.body)
    if (mention?.status === 'busy') {
      coordinator.queueInputForActiveAgent(mention.id, message.body)
    }
    if (mention?.status === 'idle' && taskId) {
      const task = repositories.getTask(taskId)
      if (task?.status === 'queued' && task.directAgentId === mention.id) {
        scheduler.claimNext(mention.id)
        await coordinator.flush(taskId)
      }
    }
    response.status(201).json(message)
  }))

  app.post('/api/tasks/:taskId/review', asyncRoute(async (request, response) => {
    const body = objectBody(request.body)
    assertOnlyKeys(body, ['action', 'message'])
    const action = requiredString(body, 'action')
    if (action !== 'accept' && action !== 'return') throw new ValidationError('action must be accept or return.')
    const task = await reviewService.review(requiredParam(request.params.taskId, 'taskId'), action, requiredString(body, 'message'))
    response.json(task)
  }))

  app.post('/api/tasks/:taskId/merge', asyncRoute((_request, response) => {
    response.status(501).json({ error: '第一版只记录验收，合并需要独立人工流程。' })
  }))

  app.post('/api/tasks/:taskId/cancel', asyncRoute((request, response) => {
    const body = objectBody(request.body)
    assertOnlyKeys(body, ['reason'])
    const task = taskService.cancelTask(requiredParam(request.params.taskId, 'taskId'), requiredString(body, 'reason'))
    response.json(task)
  }))

  app.get('/api/tasks/:taskId/artifacts/:artifactId', asyncRoute(async (request, response) => {
    const artifact = await taskService.readArtifact(
      requiredParam(request.params.taskId, 'taskId'), requiredParam(request.params.artifactId, 'artifactId'),
    )
    response.type(artifact.kind === 'runtime-stderr' ? 'text/plain' : 'application/json').send(artifact.content)
  }))

  app.get('/events', (request, response) => {
    eventPublisher.handle(request, response)
  })

  app.use(errorHandler)

  return app
}

function findMentionedAgent(repositories: WorkspaceRepositories, channelId: string, body: string) {
  for (const workspace of repositories.getBootstrap().workspaces) {
    if (!workspace.repositories.some((repository) => repository.channels.some((channel) => channel.id === channelId))) continue
    return workspace.agents.find((agent) => exactMention(body, agent.mentionName))
  }
  return undefined
}

function exactMention(body: string, mention: string): boolean {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[,.!?，。！？])`, 'i').test(body)
}

class RepositoryWorkspaceCatalog implements WorkspaceCatalog {
  constructor(private readonly repositories: WorkspaceRepositories) {}

  hasWorkspace(workspaceId: string): boolean {
    return this.repositories.getBootstrap().workspaces.some((workspace) => workspace.id === workspaceId)
  }

  hasRepository(repositoryId: string): boolean {
    return this.repositories.getBootstrap().workspaces.some((workspace) =>
      workspace.repositories.some((repository) => repository.id === repositoryId),
    )
  }

  hasAgentMention(workspaceId: string, mention: string): boolean {
    return this.repositories.hasAgentMention(workspaceId, mention)
  }

  createWorkspace(input: { name: string; leaseTtlMs?: number }) {
    return this.repositories.createWorkspace(input)
  }

  inTransaction<T>(work: (catalog: WorkspaceMutationCatalog) => T): T {
    return this.repositories.inTransaction((unitOfWork) => work(new TransactionWorkspaceCatalog(unitOfWork)))
  }

  createRepository(input: Parameters<WorkspaceRepositories['createRepository']>[0]) {
    return this.repositories.createRepository(input)
  }

  createChannel(input: { repositoryId: string; name: string }) {
    return this.repositories.createChannel(input)
  }

  createAgent(input: Parameters<WorkspaceRepositories['createAgent']>[0]) {
    return this.repositories.createAgent(input)
  }
}

class TransactionWorkspaceCatalog {
  constructor(private readonly unitOfWork: WorkspaceUnitOfWork) {}

  createRepository: WorkspaceCatalog['createRepository'] = (input) => this.unitOfWork.createRepository(input)
  createChannel: WorkspaceCatalog['createChannel'] = (input) => this.unitOfWork.createChannel(input)
}

function asyncRoute(handler: (request: express.Request, response: express.Response) => void | Promise<void>): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response)).catch(next)
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${key} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (body[key] === undefined) return undefined
  return requiredString(body, key)
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ValidationError(`${key} must be an array of non-empty strings.`)
  }
  return value.map((item) => item.trim())
}

function optionalPositiveInteger(body: Record<string, unknown>, key: string): number | undefined {
  if (body[key] === undefined) return undefined
  const value = body[key]
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ValidationError(`${key} must be a positive integer.`)
  }
  return value as number
}

function optionalNonNegativeInteger(body: Record<string, unknown>, key: string): number | undefined {
  if (body[key] === undefined) return undefined
  const value = body[key]
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ValidationError(`${key} must be a non-negative integer.`)
  }
  return value as number
}

function assertOnlyKeys(body: Record<string, unknown>, acceptedKeys: string[]): void {
  const unknownKeys = Object.keys(body).filter((key) => !acceptedKeys.includes(key))
  if (unknownKeys.length > 0) {
    throw new ValidationError(`Unsupported field: ${unknownKeys[0]}.`)
  }
}

function runtimeOverrides(body: Record<string, unknown>) {
  const overrides: { command?: string; model?: string; args?: string[]; env?: Record<string, string> } = {}
  const command = optionalString(body, 'command')
  const model = optionalString(body, 'model')
  if (command !== undefined) overrides.command = command
  if (model !== undefined) overrides.model = model
  if (body.args !== undefined) overrides.args = requiredStringArray(body, 'args')
  if (body.env !== undefined) {
    const env = objectBody(body.env)
    if (Object.values(env).some((value) => typeof value !== 'string')) {
      throw new ValidationError('env values must be strings.')
    }
    overrides.env = env as Record<string, string>
  }
  return overrides
}

function requiredParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new ValidationError(`${name} is required.`)
  return value
}

function sanitizeBootstrap(snapshot: ReturnType<WorkspaceRepositories['getBootstrap']>) {
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      agents: workspace.agents.map((agent) => ({ ...agent, env: Object.keys(agent.env) })),
    })),
  }
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ValidationError || error instanceof SyntaxError) {
    response.status(400).json({ error: error.message })
    return
  }
  if (error instanceof NotFoundError) {
    response.status(404).json({ error: error.message })
    return
  }
  if (error instanceof DomainError) {
    response.status(409).json({ error: error.message })
    return
  }
  response.status(500).json({ error: 'Internal server error.' })
}

function defaultDatabasePath(): string {
  if (process.env.NODE_ENV === 'test') {
    return ':memory:'
  }

  return path.join(getServiceConfig().dataDir, 'sinapsis.sqlite')
}
