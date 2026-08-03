import type { AgentView, ChannelMessage, ChannelView, ConversationTurnDetailView, DreamRunView, MemoryCandidateStatus, MemoryCandidateView, MemoryScope, MemoryView, RepositoryView, TaskDetailView, TaskInputView, TaskView, WorkspaceSnapshot, WorkspaceView } from '../domain/workspace-view'

export interface WorkspaceApi {
  getBootstrap(): Promise<WorkspaceSnapshot>
  createWorkspace(input: { name: string }): Promise<WorkspaceView>
  addRepository(workspaceId: string, input: { directory: string; name?: string }): Promise<RepositoryView>
  createAgent(input: CreateAgentRequest): Promise<AgentView>
  updateAgentResponsibilities(agentId: string, responsibilities: string[]): Promise<AgentView>
  refreshAgentRuntime(agentId: string): Promise<void>
  postMessage(channelId: string, input: { body: string; taskId?: string; threadRootMessageId?: string }): Promise<ChannelMessage>
  getChannelMessage(channelId: string, messageId: string): Promise<{ message: ChannelMessage; threadRoot: ChannelMessage | null }>
  createChannel(input: { name: string }): Promise<ChannelView>
  archiveChannel(channelId: string): Promise<ChannelView>
  restoreChannel(channelId: string): Promise<ChannelView>
  resetChannelContext(channelId: string): Promise<ChannelView>
  addChannelAgent(channelId: string, agentId: string): Promise<AgentView[]>
  removeChannelAgent(channelId: string, agentId: string): Promise<AgentView[]>
  bindChannelWorkspace(channelId: string, workspaceId: string): Promise<WorkspaceView[]>
  unbindChannelWorkspace(channelId: string, workspaceId: string): Promise<WorkspaceView[]>
  createTask(channelId: string, input: CreateTaskRequest): Promise<TaskView>
  getConversationTurn(channelId: string, turnId: string): Promise<ConversationTurnDetailView>
  cancelConversationTurn(channelId: string, turnId: string): Promise<void>
  getTaskDetails(taskId: string): Promise<TaskDetailView>
  queueTaskInput(taskId: string, body: string): Promise<TaskInputView>
  reviewTask(taskId: string, action: 'accept' | 'return', message: string): Promise<TaskView>
  requeueTask(taskId: string): Promise<TaskView>
  readArtifact(taskId: string, artifactId: string): Promise<string>
  listDreamRuns(): Promise<DreamRunView[]>
  startDream(channelId?: string): Promise<DreamRunView[]>
  listMemoryCandidates(status: MemoryCandidateStatus): Promise<MemoryCandidateView[]>
  acceptMemoryCandidate(id: string, input: AcceptMemoryCandidateRequest): Promise<MemoryView>
  ignoreMemoryCandidate(id: string): Promise<MemoryCandidateView>
  listMemories(): Promise<MemoryView[]>
  updateMemory(id: string, content: string): Promise<MemoryView>
  archiveMemory(id: string): Promise<MemoryView>
}

export interface CreateTaskRequest {
  workspaceId: string
  title: string
  description: string
  acceptanceCriteria: string
  labels: string[]
  directAgentId?: string
}

export interface CreateAgentRequest {
  identity: string
  mention: string
  runtime: 'opencode' | 'pi' | 'claude-code'
  capabilityTags: string[]
  responsibilities?: string[]
}

export interface AcceptMemoryCandidateRequest {
  scope: MemoryScope
  channelId?: string
  content: string
}

export class ApiClient implements WorkspaceApi {
  async getBootstrap(): Promise<WorkspaceSnapshot> { return this.request('/api/bootstrap') }
  async createWorkspace(input: { name: string }): Promise<WorkspaceView> {
    return this.request('/api/workspaces', { method: 'POST', body: JSON.stringify(input) })
  }
  async addRepository(workspaceId: string, input: { directory: string; name?: string }): Promise<RepositoryView> {
    return this.request(`/api/workspaces/${workspaceId}/repositories`, { method: 'POST', body: JSON.stringify(input) })
  }
  async createAgent(input: CreateAgentRequest): Promise<AgentView> {
    return this.request('/api/agents', { method: 'POST', body: JSON.stringify(input) })
  }
  async updateAgentResponsibilities(agentId: string, responsibilities: string[]): Promise<AgentView> {
    return this.request(`/api/agents/${agentId}/responsibilities`, { method: 'PUT', body: JSON.stringify({ responsibilities }) })
  }
  async refreshAgentRuntime(agentId: string): Promise<void> {
    await this.request(`/api/agents/${agentId}/refresh-runtime`, { method: 'POST' })
  }
  async postMessage(channelId: string, input: { body: string; taskId?: string; threadRootMessageId?: string }): Promise<ChannelMessage> {
    return this.request(`/api/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(input) })
  }
  async getChannelMessage(channelId: string, messageId: string): Promise<{ message: ChannelMessage; threadRoot: ChannelMessage | null }> {
    return this.request(`/api/channels/${channelId}/messages/${messageId}`)
  }
  async createChannel(input: { name: string }): Promise<ChannelView> {
    return this.request('/api/channels', { method: 'POST', body: JSON.stringify(input) })
  }
  async archiveChannel(channelId: string): Promise<ChannelView> {
    return this.request(`/api/channels/${channelId}/archive`, { method: 'POST' })
  }
  async restoreChannel(channelId: string): Promise<ChannelView> {
    return this.request(`/api/channels/${channelId}/restore`, { method: 'POST' })
  }
  async resetChannelContext(channelId: string): Promise<ChannelView> {
    return this.request(`/api/channels/${channelId}/context-reset`, { method: 'POST' })
  }
  async addChannelAgent(channelId: string, agentId: string): Promise<AgentView[]> {
    return this.request(`/api/channels/${channelId}/agents`, { method: 'POST', body: JSON.stringify({ agentId }) })
  }
  async removeChannelAgent(channelId: string, agentId: string): Promise<AgentView[]> {
    return this.request(`/api/channels/${channelId}/agents/${agentId}`, { method: 'DELETE' })
  }
  async bindChannelWorkspace(channelId: string, workspaceId: string): Promise<WorkspaceView[]> {
    return this.request(`/api/channels/${channelId}/workspaces`, { method: 'POST', body: JSON.stringify({ workspaceId }) })
  }
  async unbindChannelWorkspace(channelId: string, workspaceId: string): Promise<WorkspaceView[]> {
    return this.request(`/api/channels/${channelId}/workspaces/${workspaceId}`, { method: 'DELETE' })
  }
  async createTask(channelId: string, input: CreateTaskRequest): Promise<TaskView> {
    return this.request(`/api/channels/${channelId}/tasks`, { method: 'POST', body: JSON.stringify(input) })
  }
  async getConversationTurn(channelId: string, turnId: string): Promise<ConversationTurnDetailView> {
    return this.request(`/api/channels/${channelId}/turns/${turnId}`)
  }
  async cancelConversationTurn(channelId: string, turnId: string): Promise<void> {
    await this.request(`/api/channels/${channelId}/turns/${turnId}/cancel`, { method: 'POST' })
  }
  async getTaskDetails(taskId: string): Promise<TaskDetailView> { return this.request(`/api/tasks/${taskId}`) }
  async queueTaskInput(taskId: string, body: string): Promise<TaskInputView> {
    return this.request(`/api/tasks/${taskId}/input`, { method: 'POST', body: JSON.stringify({ body }) })
  }
  async reviewTask(taskId: string, action: 'accept' | 'return', message: string): Promise<TaskView> {
    return this.request(`/api/tasks/${taskId}/review`, { method: 'POST', body: JSON.stringify({ action, message }) })
  }
  async requeueTask(taskId: string): Promise<TaskView> {
    return this.request(`/api/tasks/${taskId}/requeue`, { method: 'POST' })
  }
  async readArtifact(taskId: string, artifactId: string): Promise<string> {
    const response = await fetch(`/api/tasks/${taskId}/artifacts/${artifactId}`, { headers: { 'Content-Type': 'application/json' } })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined)
      throw new Error(isErrorPayload(payload) ? payload.error : `请求失败 (${response.status})`)
    }
    return response.text()
  }
  async listDreamRuns(): Promise<DreamRunView[]> { return this.request('/api/dream/runs') }
  async startDream(channelId?: string): Promise<DreamRunView[]> {
    return this.request('/api/dream/runs', { method: 'POST', body: JSON.stringify(channelId ? { channelId } : {}) })
  }
  async listMemoryCandidates(status: MemoryCandidateStatus): Promise<MemoryCandidateView[]> {
    return this.request(`/api/memory-candidates?status=${encodeURIComponent(status)}`)
  }
  async acceptMemoryCandidate(id: string, input: AcceptMemoryCandidateRequest): Promise<MemoryView> {
    return this.request(`/api/memory-candidates/${id}/accept`, { method: 'POST', body: JSON.stringify(input) })
  }
  async ignoreMemoryCandidate(id: string): Promise<MemoryCandidateView> {
    return this.request(`/api/memory-candidates/${id}/ignore`, { method: 'POST', body: JSON.stringify({}) })
  }
  async listMemories(): Promise<MemoryView[]> { return this.request('/api/memories') }
  async updateMemory(id: string, content: string): Promise<MemoryView> {
    return this.request(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ content }) })
  }
  async archiveMemory(id: string): Promise<MemoryView> { return this.request(`/api/memories/${id}`, { method: 'DELETE' }) }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message = isErrorPayload(payload) ? payload.error : `请求失败 (${response.status})`
      throw new Error(message)
    }
    return payload as T
  }
}

function isErrorPayload(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
}
