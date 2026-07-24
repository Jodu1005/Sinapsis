import type { ChannelMessage, ChannelView, RepositoryView, WorkspaceSnapshot, WorkspaceView } from '../domain/workspace-view'

export interface WorkspaceApi {
  getBootstrap(): Promise<WorkspaceSnapshot>
  createWorkspace(input: { name: string }): Promise<WorkspaceView>
  addRepository(workspaceId: string, input: { directory: string; name?: string }): Promise<RepositoryView>
  postMessage(channelId: string, input: { body: string; taskId?: string }): Promise<ChannelMessage>
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
