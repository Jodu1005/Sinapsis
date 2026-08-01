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

  const agentMention = findKnownAgentMention(taskContent, agents)
  if (!agentMention) {
    const unknownMention = /(^|\s)(@[^\s]+)/.exec(taskContent)
    if (unknownMention) return { kind: 'error', message: `找不到 Agent ${unknownMention[2]}。` }
    return { kind: 'task', title: taskContent, directAgentId: undefined }
  }

  const taskBody = `${taskContent.slice(0, agentMention.start)}${taskContent.slice(agentMention.end)}`.trim()
  if (!taskBody) {
    return { kind: 'error', message: '请补充任务内容。' }
  }

  return { kind: 'task', title: taskBody, directAgentId: agentMention.agent.id }
}

function findKnownAgentMention(taskContent: string, agents: AgentView[]): { agent: AgentView; start: number; end: number } | undefined {
  const candidates = distinctAgentsByIdentity(agents)
    .flatMap((agent) => [
      { agent, label: agent.identity },
      { agent, label: agent.mentionName },
    ])
    .filter((candidate) => candidate.label.trim())
    .sort((left, right) => right.label.length - left.label.length)

  for (const candidate of candidates) {
    const match = new RegExp(`(^|\\s)(${escapeRegExp(`@${candidate.label}`)})(?=\\s|$)`, 'iu').exec(taskContent)
    if (!match) continue
    const start = match.index + (match[1]?.length ?? 0)
    return { agent: candidate.agent, start, end: start + (match[2]?.length ?? 0) }
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
