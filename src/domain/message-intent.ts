import type { AgentView } from './workspace-view'

export type MessageIntent =
  | { kind: 'message'; body: string }
  | { kind: 'task'; body: string; directAgentId?: string }
  | { kind: 'error'; message: string }

export function parseMessageIntent(body: string, agents: AgentView[]): MessageIntent {
  const trimmedBody = body.trim()

  if (!/^\/task(?:\s|$)/.test(trimmedBody)) {
    return { kind: 'message', body: trimmedBody }
  }

  const taskContent = trimmedBody.slice('/task'.length).trim()
  if (!taskContent) {
    return { kind: 'error', message: '请补充任务内容。' }
  }

  const mentionMatch = /(^|\s)(@[^\s]+)/.exec(taskContent)
  if (!mentionMatch) {
    return { kind: 'task', body: taskContent, directAgentId: undefined }
  }

  const mention = mentionMatch[2]
  const agent = agents.find((candidate) => candidate.mentionName === mention.slice(1))
  if (!agent) {
    return { kind: 'error', message: `找不到 Agent ${mention}。` }
  }

  const mentionStart = mentionMatch.index + mentionMatch[1].length
  const taskBody = `${taskContent.slice(0, mentionStart)}${taskContent.slice(mentionStart + mention.length)}`.trim()
  if (!taskBody) {
    return { kind: 'error', message: '请补充任务内容。' }
  }

  return { kind: 'task', body: taskBody, directAgentId: agent.id }
}
