import { describe, expect, it } from 'vitest'
import {
  memoryContentHash,
  normalizeMemoryContent,
  parseMemoryConsolidation,
} from './memory-consolidation-protocol'

const allowedSourceMessageIds = ['message-1', 'message-2']

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'global',
    kind: 'preference',
    content: 'User prefers Chinese.',
    rationale: 'The user confirmed this preference.',
    confidence: 0.9,
    importance: 0.8,
    sourceMessageIds: ['message-1'],
    ...overrides,
  }
}

function payload(...candidates: Array<Record<string, unknown>>): string {
  return JSON.stringify({ candidates })
}

describe('memory consolidation protocol', () => {
  it('accepts an empty candidate list as a no-op', () => {
    expect(parseMemoryConsolidation('{"candidates":[]}', allowedSourceMessageIds)).toEqual({ candidates: [] })
  })

  it('unwraps exactly one JSON Markdown fence', () => {
    expect(parseMemoryConsolidation('```json\n{"candidates":[]}\n```', allowedSourceMessageIds)).toEqual({ candidates: [] })
    expect(() => parseMemoryConsolidation('```json\n```json\n{"candidates":[]}\n```\n```', allowedSourceMessageIds)).toThrow()
  })

  it('rejects extra or missing top-level and candidate fields', () => {
    expect(() => parseMemoryConsolidation(JSON.stringify({ candidates: [], explanation: 'none' }), allowedSourceMessageIds)).toThrow()
    expect(() => parseMemoryConsolidation('{}', allowedSourceMessageIds)).toThrow()
    expect(() => parseMemoryConsolidation(payload(candidate({ extra: true })), allowedSourceMessageIds)).toThrow()

    const missingRationale = candidate()
    delete missingRationale.rationale
    expect(() => parseMemoryConsolidation(payload(missingRationale), allowedSourceMessageIds)).toThrow()
  })

  it('accepts only supported memory scopes and kinds', () => {
    const scopes = ['global', 'channel'] as const
    const kinds = ['preference', 'decision', 'constraint', 'fact', 'workflow'] as const

    for (const scope of scopes) {
      for (const kind of kinds) {
        expect(parseMemoryConsolidation(payload(candidate({ scope, kind })), allowedSourceMessageIds).candidates[0])
          .toMatchObject({ scope, kind })
      }
    }

    expect(() => parseMemoryConsolidation(payload(candidate({ scope: 'user' })), allowedSourceMessageIds)).toThrow()
    expect(() => parseMemoryConsolidation(payload(candidate({ kind: 'secret' })), allowedSourceMessageIds)).toThrow()
  })

  it('requires confidence and importance to be finite numbers in the inclusive unit interval', () => {
    for (const field of ['confidence', 'importance'] as const) {
      expect(parseMemoryConsolidation(payload(candidate({ [field]: 0 })), allowedSourceMessageIds).candidates[0][field]).toBe(0)
      expect(parseMemoryConsolidation(payload(candidate({ [field]: 1 })), allowedSourceMessageIds).candidates[0][field]).toBe(1)
      expect(() => parseMemoryConsolidation(payload(candidate({ [field]: -0.01 })), allowedSourceMessageIds)).toThrow()
      expect(() => parseMemoryConsolidation(payload(candidate({ [field]: 1.01 })), allowedSourceMessageIds)).toThrow()
      expect(() => parseMemoryConsolidation(payload(candidate({ [field]: '0.5' })), allowedSourceMessageIds)).toThrow()
    }

    expect(() => parseMemoryConsolidation(
      payload(candidate()).replace('"confidence":0.9', '"confidence":1e400'),
      allowedSourceMessageIds,
    )).toThrow()
  })

  it('rejects empty content and rationale text', () => {
    expect(() => parseMemoryConsolidation(payload(candidate({ content: ' \n\t ' })), allowedSourceMessageIds)).toThrow()
    expect(() => parseMemoryConsolidation(payload(candidate({ rationale: '' })), allowedSourceMessageIds)).toThrow()
  })

  it('requires every source ID to be allowed and unique', () => {
    expect(parseMemoryConsolidation(
      payload(candidate({ sourceMessageIds: ['message-2', 'message-1'] })),
      allowedSourceMessageIds,
    ).candidates[0].sourceMessageIds).toEqual(['message-2', 'message-1'])

    expect(() => parseMemoryConsolidation(
      payload(candidate({ sourceMessageIds: ['forged-message'] })),
      allowedSourceMessageIds,
    )).toThrow()
    expect(() => parseMemoryConsolidation(
      payload(candidate({ sourceMessageIds: ['message-1', 'message-1'] })),
      allowedSourceMessageIds,
    )).toThrow()
    expect(() => parseMemoryConsolidation(
      payload(candidate({ sourceMessageIds: [] })),
      allowedSourceMessageIds,
    )).toThrow()
  })

  it('rejects candidate lists over the configured maximum', () => {
    expect(parseMemoryConsolidation(payload(candidate(), candidate()), allowedSourceMessageIds, 2).candidates).toHaveLength(2)
    expect(() => parseMemoryConsolidation(payload(candidate(), candidate()), allowedSourceMessageIds, 1)).toThrow(/Candidate count/)
    expect(() => parseMemoryConsolidation(payload(candidate()), allowedSourceMessageIds, 0)).toThrow(/maximum/)
    expect(() => parseMemoryConsolidation(payload(candidate()), allowedSourceMessageIds, 51)).toThrow(/maximum/)
  })

  it.each([
    'The API key is sk-proj-abcdefghijklmnopqrstuvwxyz123456.',
    'Set access_token=abcdefghijklmnopqrstuvwxyz1234567890.',
    'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz1234567890',
    'aws_secret_access_key = abcdefghijklmnopqrstuvwxyz1234567890',
    'The bearer credential is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c.',
    'Cookie: session_id=abcdefghijklmnopqrstuvwxyz1234567890',
    '.env contains DATABASE_URL=postgres://user:password@db.internal/app.',
    'The credential file is ~/.ssh/id_rsa.',
    'Use /Users/alice/.aws/credentials for authentication.',
    'Use /root/.aws/credentials for authentication.',
    'Use ~/.kube/config to access the cluster.',
    'The registry token is stored in ~/.npmrc.',
  ])('rejects secret, token, cookie, env, and credential material: %s', (content) => {
    expect(() => parseMemoryConsolidation(payload(candidate({ content })), allowedSourceMessageIds))
      .toThrow(/Unsafe memory content: (secret material|credential path)/)
  })

  it.each([
    'The deployment is currently running.',
    'This request failed once with ECONNRESET.',
    'Maybe the user prefers dark mode.',
    '我猜用户可能更喜欢深色模式。',
  ])('rejects temporary state, one-off errors, and unconfirmed guesses: %s', (content) => {
    expect(() => parseMemoryConsolidation(payload(candidate({ content })), allowedSourceMessageIds))
      .toThrow(/Unsafe memory content: (temporary state|one-off error|unconfirmed guess)/)
  })

  it('accepts durable workflow language that names an in-progress state', () => {
    expect(parseMemoryConsolidation(payload(candidate({
      kind: 'workflow',
      content: 'The workflow uses the in progress state before review.',
    })), allowedSourceMessageIds).candidates[0]?.content)
      .toBe('The workflow uses the in progress state before review.')
  })

  it('applies safety filtering to rationale as persisted text', () => {
    expect(() => parseMemoryConsolidation(
      payload(candidate({ rationale: 'Observed in Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890' })),
      allowedSourceMessageIds,
    )).toThrow(/Unsafe memory rationale: secret material/)
    expect(() => parseMemoryConsolidation(
      payload(candidate({ rationale: 'Probably true, but not confirmed.' })),
      allowedSourceMessageIds,
    )).toThrow(/Unsafe memory rationale: unconfirmed guess/)
  })

  it('exports repository-compatible content normalization and SHA-256 hashing', () => {
    expect(normalizeMemoryContent('  User prefers Chinese. \n')).toBe('User prefers Chinese.')
    expect(memoryContentHash('  User prefers Chinese. \n')).toBe('6facc496ebbef94ad28d218bc7c9616a0516baa9601c024d3db7c8e9aabf063f')

    const parsed = parseMemoryConsolidation(
      payload(candidate({ content: '  User prefers Chinese. \n', rationale: '  Confirmed twice.  ' })),
      allowedSourceMessageIds,
    )
    expect(parsed.candidates[0]).toMatchObject({
      content: 'User prefers Chinese.',
      rationale: 'Confirmed twice.',
    })
  })
})
