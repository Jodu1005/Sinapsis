import type { Agent } from '../domain/agent'
import type { MentionRoute } from '../domain/conversation'

interface MentionMatch {
  agentId: string
  start: number
  end: number
}

interface ParsedMention {
  name: string
  start: number
  end: number
}

export class UnknownMentionError extends Error {
  constructor(readonly mentions: string[]) {
    super(mentions.length === 1
      ? `Unknown mention @${mentions[0]}.`
      : `Unknown mentions ${mentions.map((mention) => `@${mention}`).join(', ')}.`)
    this.name = 'UnknownMentionError'
  }
}

export function routeMentions(body: string, agents: Agent[]): MentionRoute {
  const mentions = leadingMentions(body, agents)
  const matches = agentMentionMatches(mentions, agents)
  const allMention = mentions.filter((mention) => mention.name.toLocaleLowerCase() === 'all')
  const knownMentions = new Set([...matches.map((match) => match.start), ...allMention.map((match) => match.start)])
  const unknownMentions = mentions
    .filter((mention) => !knownMentions.has(mention.start) && !mention.name.includes('/'))
    .map((mention) => mention.name)
    .filter((mention, index, values) => values.indexOf(mention) === index)

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

function agentMentionMatches(mentions: ParsedMention[], agents: Agent[]): MentionMatch[] {
  const aliases = new Map<string, string>()
  for (const agent of agents) {
    for (const alias of [agent.identity, agent.mentionName].map((value) => value.trim()).filter(Boolean)) {
      aliases.set(alias.toLocaleLowerCase(), agent.id)
    }
  }
  return mentions.flatMap((mention) => {
    const agentId = aliases.get(mention.name.toLocaleLowerCase())
    return agentId ? [{ agentId, start: mention.start, end: mention.end }] : []
  })
}

function leadingMentions(body: string, agents: Agent[]): ParsedMention[] {
  const mentions: ParsedMention[] = []
  const knownAliases = [...new Set([
    'all',
    ...agents.flatMap((agent) => [agent.identity, agent.mentionName].map((value) => value.trim()).filter(Boolean)),
  ])].sort((left, right) => right.length - left.length)
  let offset = 0
  for (const line of body.split('\n')) {
    const prefix = line.match(/^[\t ]*(?:(?:>|[-*+])\s+|\d+[.)]\s+)?/)![0]
    let cursor = prefix.length
    while (cursor < line.length) {
      const knownAlias = knownAliases.find((alias) => matchesKnownAlias(line, cursor, alias))
      const match = knownAlias
        ? [`@${knownAlias}`, knownAlias]
        : line.slice(cursor).match(/^@([\p{L}\p{N}_/-]+)(?=$|[^A-Za-z0-9_/-])/u)
      if (!match) break
      const start = offset + cursor
      mentions.push({ name: match[1]!, start, end: start + match[0].length })
      cursor += match[0].length
      const whitespace = line.slice(cursor).match(/^[\t ]+/)?.[0] ?? ''
      cursor += whitespace.length
    }
    offset += line.length + 1
  }
  return mentions
}

function matchesKnownAlias(line: string, cursor: number, alias: string): boolean {
  const candidate = line.slice(cursor + 1, cursor + 1 + alias.length)
  if (candidate.toLocaleLowerCase() !== alias.toLocaleLowerCase()) return false
  const next = line[cursor + alias.length + 1]
  return next === undefined || !/[A-Za-z0-9_/-]/u.test(next)
}

function byFirstMention(left: MentionMatch, right: MentionMatch): number {
  return left.start - right.start || right.end - left.end || left.agentId.localeCompare(right.agentId)
}
