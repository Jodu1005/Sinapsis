import { createHash } from 'node:crypto'
import type { MemoryKind, MemoryScope } from '../domain/memory'

const candidateFields = [
  'scope',
  'kind',
  'content',
  'rationale',
  'confidence',
  'importance',
  'sourceMessageIds',
] as const
const memoryScopes: readonly MemoryScope[] = ['global', 'channel']
const memoryKinds: readonly MemoryKind[] = ['preference', 'decision', 'constraint', 'fact', 'workflow']
const absoluteMaxCandidates = 50

const unsafeTextPatterns: Array<{ reason: string; patterns: RegExp[] }> = [
  {
    reason: 'secret material',
    patterns: [
      /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{12,}\b/i,
      /\bAKIA[A-Z0-9]{12,}\b/i,
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
      /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*\S{8,}/i,
      /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|secret|password|passwd|cookie|session_?id|database_url)\b\s*[:=]\s*\S{8,}/i,
      /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/i,
      /\bcookie\s*:\s*[^\s=;]+=[^\s;]+/i,
      /\.env\b[^\n]*\b[A-Z][A-Z0-9_]*\s*=\s*\S+/,
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    ],
  },
  {
    reason: 'credential path',
    patterns: [
      /(?:~|(?:\/[^/\s]+)+)\/\.(?:ssh\/(?:id_(?:rsa|ed25519)|config)|aws\/credentials|config\/gcloud\/application_default_credentials\.json|kube\/config|npmrc)\b/i,
      /\b[A-Z]:\\Users\\[^\\\s]+\\\.(?:ssh\\id_(?:rsa|ed25519)|aws\\credentials)\b/i,
    ],
  },
  {
    reason: 'one-off error',
    patterns: [
      /\b(?:failed|errored?)\s+(?:just\s+)?once\b/i,
      /\b(?:one[- ]off|single|this)\s+(?:request|run|attempt)\b[^.\n]*(?:fail|error|exception|ECONN|HTTP\s*5\d\d)/i,
      /(?:这次|本次|单次|一次性|偶发)[^。\n]*(?:失败|报错|错误|异常)/,
    ],
  },
  {
    reason: 'unconfirmed guess',
    patterns: [
      /\b(?:maybe|perhaps|probably|possibly|presumably|apparently|unconfirmed)\b/i,
      /\b(?:i\s+(?:guess|think|suspect)|not\s+(?:yet\s+)?confirmed|might\s+be|could\s+be)\b/i,
      /(?:我猜|也许|大概|可能|似乎|推测|未经确认|尚未确认|未确认)/,
    ],
  },
  {
    reason: 'temporary state',
    patterns: [
      /\b(?:currently|right now|for now|at the moment|temporarily|still running)\b/i,
      /\b(?:is|are|remains?)\s+in progress\b/i,
      /(?:当前|现在|暂时|正在|临时)[^。\n]*(?:运行|进行|处理|失败|报错|错误|状态)/,
    ],
  },
]

export interface ProposedMemory {
  scope: MemoryScope
  kind: MemoryKind
  content: string
  rationale: string
  confidence: number
  importance: number
  sourceMessageIds: string[]
}

export interface MemoryConsolidationResult {
  candidates: ProposedMemory[]
}

export function parseMemoryConsolidation(
  raw: string,
  allowedSourceMessageIds: readonly string[],
  maxCandidates = 20,
): MemoryConsolidationResult {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > absoluteMaxCandidates) {
    throw new Error(`Candidate maximum must be an integer from 1 through ${absoluteMaxCandidates}.`)
  }

  const value = parseStructuredObject(raw)
  assertExactFields(value, ['candidates'], 'Memory consolidation result')
  if (!Array.isArray(value.candidates)) throw new Error('Memory consolidation candidates must be an array.')
  if (value.candidates.length > maxCandidates) {
    throw new Error(`Candidate count must not exceed ${maxCandidates}.`)
  }

  const allowedSources = new Set(allowedSourceMessageIds)
  return { candidates: value.candidates.map((item, index) => parseCandidate(item, index, allowedSources)) }
}

export function normalizeMemoryContent(content: string): string {
  return requiredText(content, 'Memory content')
}

export function memoryContentHash(content: string): string {
  return createHash('sha256').update(normalizeMemoryContent(content)).digest('hex')
}

export function assertSafeMemoryContent(content: string): void {
  assertSafeText(content, 'content')
}

function parseCandidate(value: unknown, index: number, allowedSources: ReadonlySet<string>): ProposedMemory {
  if (!isRecord(value)) throw new Error(`Memory candidate ${index} must be a JSON object.`)
  assertExactFields(value, candidateFields, `Memory candidate ${index}`)

  const scope = memoryScope(value.scope)
  const kind = memoryKind(value.kind)
  const content = normalizeMemoryContent(value.content as string)
  const rationale = requiredText(value.rationale, 'Memory rationale')
  assertSafeText(content, 'content')
  assertSafeText(rationale, 'rationale')

  return {
    scope,
    kind,
    content,
    rationale,
    confidence: unitInterval(value.confidence, 'Memory confidence'),
    importance: unitInterval(value.importance, 'Memory importance'),
    sourceMessageIds: sourceIds(value.sourceMessageIds, allowedSources),
  }
}

function parseStructuredObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string') throw new Error('Memory consolidation output must be text.')
  const text = unwrapJsonFence(raw.trim())
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Expected valid JSON memory consolidation output.')
  }
  if (!isRecord(value)) throw new Error('Memory consolidation output must be a JSON object.')
  return value
}

function unwrapJsonFence(value: string): string {
  if (!value.startsWith('```')) return value
  const match = value.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i)
  if (!match) throw new Error('Invalid JSON fence around memory consolidation output.')
  return match[1].trim()
}

function assertExactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(', ')}.`)
  const missing = fields.filter((key) => !(key in value))
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(', ')}.`)
}

function memoryScope(value: unknown): MemoryScope {
  if (typeof value === 'string' && memoryScopes.includes(value as MemoryScope)) return value as MemoryScope
  throw new Error('Memory scope must be global or channel.')
}

function memoryKind(value: unknown): MemoryKind {
  if (typeof value === 'string' && memoryKinds.includes(value as MemoryKind)) return value as MemoryKind
  throw new Error(`Memory kind must be one of: ${memoryKinds.join(', ')}.`)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`)
  return value.trim()
}

function unitInterval(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number from 0 through 1.`)
  }
  return value
}

function sourceIds(value: unknown, allowedSources: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Memory sourceMessageIds must be a non-empty array.')
  }

  const seen = new Set<string>()
  return value.map((sourceId) => {
    if (typeof sourceId !== 'string' || !sourceId) throw new Error('Memory source message IDs must be non-empty strings.')
    if (!allowedSources.has(sourceId)) throw new Error(`Memory source message ID is not allowed: ${sourceId}.`)
    if (seen.has(sourceId)) throw new Error(`Memory source message ID is duplicated: ${sourceId}.`)
    seen.add(sourceId)
    return sourceId
  })
}

function assertSafeText(value: string, field: 'content' | 'rationale'): void {
  for (const category of unsafeTextPatterns) {
    if (category.patterns.some((pattern) => pattern.test(value))) {
      throw new Error(`Unsafe memory ${field}: ${category.reason}.`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
