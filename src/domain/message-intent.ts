import { distinctAgentsByIdentity, type AgentView } from './workspace-view'

export type MessageIntent =
  | { kind: 'message'; body: string }
  | { kind: 'task'; title: string; directAgentId?: string }
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
    return { kind: 'task', title: taskContent, directAgentId: undefined }
  }

  const mention = mentionMatch[2]
  const agent = distinctAgentsByIdentity(agents).find((candidate) => matchesAgentMention(candidate, mention.slice(1)))
  if (!agent) {
    return { kind: 'error', message: `找不到 Agent ${mention}。` }
  }

  const mentionStart = mentionMatch.index + mentionMatch[1].length
  const taskBody = `${taskContent.slice(0, mentionStart)}${taskContent.slice(mentionStart + mention.length)}`.trim()
  if (!taskBody) {
    return { kind: 'error', message: '请补充任务内容。' }
  }

  return { kind: 'task', title: taskBody, directAgentId: agent.id }
}

function matchesAgentMention(agent: AgentView, mention: string): boolean {
  const normalizedMention = mention.toLocaleLowerCase()
  return agent.identity?.toLocaleLowerCase() === normalizedMention || agent.mentionName.toLocaleLowerCase() === normalizedMention
}
