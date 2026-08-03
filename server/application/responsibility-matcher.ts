import type { Agent } from '../domain/agent'
import type { ResponsibilityCandidate } from '../domain/conversation'

export function matchResponsibilities(
  body: string,
  agents: Agent[],
  limit: number,
): ResponsibilityCandidate[] {
  const message = body.toLocaleLowerCase()
  return agents
    .map((agent) => responsibilityCandidate(agent, message))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.agent.updatedAt.localeCompare(right.agent.updatedAt) || left.agent.id.localeCompare(right.agent.id))
    .slice(0, Math.max(0, limit))
}

function responsibilityCandidate(agent: Agent, message: string): ResponsibilityCandidate {
  const descriptors = [...(agent.responsibilities ?? []), ...agent.capabilityTags]
    .map((value) => value.trim())
    .filter(Boolean)
  const matches = descriptors.map((descriptor) => ({ descriptor, score: descriptorScore(descriptor, message) }))
  return {
    agent,
    score: matches.reduce((total, match) => total + match.score, 0),
    matchedDescriptors: matches.filter((match) => match.score > 0).map((match) => match.descriptor),
  }
}

function descriptorScore(descriptor: string, message: string): number {
  const normalized = descriptor.toLocaleLowerCase()
  if (normalized === '通用回复' || normalized === 'general') return 1
  if (message.includes(normalized)) return 12
  return (intersectionSize(cjkBigrams(normalized), cjkBigrams(message)) * 3) + intersectionSize(words(normalized), words(message))
}

function cjkBigrams(value: string): Set<string> {
  const characters = [...value].filter((character) => /\p{Script=Han}/u.test(character))
  return new Set(characters.slice(1).map((character, index) => `${characters[index]}${character}`))
}

function words(value: string): Set<string> {
  return new Set(value.match(/[a-z0-9][a-z0-9_-]{1,}/gi) ?? [])
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  return [...left].filter((value) => right.has(value)).length
}
