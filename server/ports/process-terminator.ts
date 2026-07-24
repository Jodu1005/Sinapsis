export interface ProcessTerminator {
  terminate(taskId: string, agentId: string): Promise<void> | void
}

export class NoopProcessTerminator implements ProcessTerminator {
  terminate(_taskId: string, _agentId: string): void {}
}
