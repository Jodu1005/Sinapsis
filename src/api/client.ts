import type { ChannelMessage, RepositoryView, TaskDetailView, TaskInputView, TaskView, WorkspaceSnapshot, WorkspaceView } from '../domain/workspace-view'

export interface WorkspaceApi {
  getBootstrap(): Promise<WorkspaceSnapshot>
  createWorkspace(input: { name: string }): Promise<WorkspaceView>
  addRepository(workspaceId: string, input: { directory: string; name?: string }): Promise<RepositoryView>
  postMessage(channelId: string, input: { body: string; taskId?: string }): Promise<ChannelMessage>
  createTask(repositoryId: string, input: CreateTaskRequest): Promise<TaskView>
  getTaskDetails(taskId: string): Promise<TaskDetailView>
  queueTaskInput(taskId: string, body: string): Promise<TaskInputView>
  reviewTask(taskId: string, action: 'accept' | 'return', message: string): Promise<TaskView>
  readArtifact(taskId: string, artifactId: string): Promise<string>
}

export interface CreateTaskRequest {
  title: string
  description: string
  acceptanceCriteria: string
  labels: string[]
  directAgentId?: string
}

export class ApiClient implements WorkspaceApi {
  async getBootstrap(): Promise<WorkspaceSnapshot> { return this.request('/api/bootstrap') }
  async createWorkspace(input: { name: string }): Promise<WorkspaceView> {
    return this.request('/api/workspaces', { method: 'POST', body: JSON.stringify(input) })
  }
  async addRepository(workspaceId: string, input: { directory: string; name?: string }): Promise<RepositoryView> {
    return this.request(`/api/workspaces/${workspaceId}/repositories`, { method: 'POST', body: JSON.stringify(input) })
  }
  async postMessage(channelId: string, input: { body: string; taskId?: string }): Promise<ChannelMessage> {
    return this.request(`/api/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(input) })
  }
  async createTask(repositoryId: string, input: CreateTaskRequest): Promise<TaskView> {
    return this.request(`/api/repositories/${repositoryId}/tasks`, { method: 'POST', body: JSON.stringify(input) })
  }
  async getTaskDetails(taskId: string): Promise<TaskDetailView> { return this.request(`/api/tasks/${taskId}`) }
  async queueTaskInput(taskId: string, body: string): Promise<TaskInputView> {
    return this.request(`/api/tasks/${taskId}/input`, { method: 'POST', body: JSON.stringify({ body }) })
  }
  async reviewTask(taskId: string, action: 'accept' | 'return', message: string): Promise<TaskView> {
    return this.request(`/api/tasks/${taskId}/review`, { method: 'POST', body: JSON.stringify({ action, message }) })
  }
  async readArtifact(taskId: string, artifactId: string): Promise<string> {
    const response = await fetch(`/api/tasks/${taskId}/artifacts/${artifactId}`, { headers: { 'Content-Type': 'application/json' } })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined)
      throw new Error(isErrorPayload(payload) ? payload.error : `请求失败 (${response.status})`)
    }
    return response.text()
  }

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
