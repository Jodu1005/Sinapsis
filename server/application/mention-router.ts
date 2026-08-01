import type { Agent } from '../domain/agent'
import type { MentionRoute } from '../domain/conversation'

interface MentionMatch {
  agentId: string
  start: number
  end: number
}

const mentionLeftBoundary = '(^|[^A-Za-z0-9_])'
const mentionRightBoundary = '(?=$|[^\\p{L}\\p{N}_/-])'

export class UnknownMentionError extends Error {
  constructor(readonly mentions: string[]) {
    super(mentions.length === 1
      ? `Unknown mention @${mentions[0]}.`
      : `Unknown mentions ${mentions.map((mention) => `@${mention}`).join(', ')}.`)
    this.name = 'UnknownMentionError'
  }
}

export function routeMentions(body: string, agents: Agent[]): MentionRoute {
  const matches = agentMentionMatches(body, agents)
  const allMention = exactMentionMatches(body, 'all')
  const unknownMentions = unknownMentionNames(body, [...matches, ...allMention])

  if (allMention.length > 0) {
    return { mode: 'all', targetAgentIds: [], unknownMentions }
  }

  const targetAgentIds = [...new Set(matches.sort(byFirstMention).map((match) => match.agentId))]
  return {
    mode: targetAgentIds.length === 0 ? 'ordinary' : targetAgentIds.length === 1 ? 'direct' : 'multi_direct',
    targetAgentIds,
    unknownMentions,
  }
}

function agentMentionMatches(body: string, agents: Agent[]): MentionMatch[] {
  return agents.flatMap((agent) => {
    const aliases = new Set([agent.identity, agent.mentionName].map((value) => value.trim()).filter(Boolean))
    return [...aliases].flatMap((alias) => exactMentionMatches(body, alias).map(({ start, end }) => ({ agentId: agent.id, start, end })))
  })
}

function exactMentionMatches(body: string, name: string): Array<Omit<MentionMatch, 'agentId'>> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`${mentionLeftBoundary}@${escaped}${mentionRightBoundary}`, 'giu')
  return [...body.matchAll(expression)].map((match) => ({
    start: match.index! + match[1].length,
    end: match.index! + match[0].length,
  }))
}

function unknownMentionNames(body: string, knownMatches: Array<Omit<MentionMatch, 'agentId'>>): string[] {
  const unknownMentions: string[] = []
  const expression = new RegExp(`${mentionLeftBoundary}@([\\p{L}\\p{N}_-]+)${mentionRightBoundary}`, 'gu')
  for (const match of body.matchAll(expression)) {
    const start = match.index! + match[1].length
    const end = start + match[0].length - match[1].length
    if (knownMatches.some((known) => start >= known.start && end <= known.end)) continue
    if (!unknownMentions.includes(match[2])) unknownMentions.push(match[2])
  }
  return unknownMentions
}

function byFirstMention(left: MentionMatch, right: MentionMatch): number {
  return left.start - right.start || right.end - left.end || left.agentId.localeCompare(right.agentId)
}
