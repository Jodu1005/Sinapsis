import { describe, expect, it } from 'vitest'
import type { Agent } from '../domain/agent'
import { matchResponsibilities } from './responsibility-matcher'

describe('matchResponsibilities', () => {
  it('ranks the Agent whose descriptors match Chinese and English terms', () => {
    const frontend = createAgent('frontend', ['React', '表单样式'])
    const backend = createAgent('backend', ['数据库迁移'])

    expect(matchResponsibilities('修复 React 表单样式', [backend, frontend], 3)).toEqual([
      expect.objectContaining({
        agent: frontend,
        matchedDescriptors: ['React', '表单样式'],
      }),
    ])
  })

  it('returns no candidates when no descriptor matches', () => {
    const frontend = createAgent('frontend', ['React 表单样式'])

    expect(matchResponsibilities('随便聊聊', [frontend], 3)).toEqual([])
  })

  it('keeps the existing general descriptor fallback', () => {
    const general = createAgent('general', ['通用回复'])

    expect(matchResponsibilities('随便聊聊', [general], 3)).toEqual([
      expect.objectContaining({ agent: general, score: 1, matchedDescriptors: ['通用回复'] }),
    ])
  })

  it('orders equal scores by oldest update and then Agent ID', () => {
    const later = createAgent('zeta', ['React'], '2026-07-31T00:02:00.000Z')
    const earlierZeta = createAgent('zeta-earlier', ['React'], '2026-07-31T00:01:00.000Z')
    const earlierAlpha = createAgent('alpha', ['React'], '2026-07-31T00:01:00.000Z')

    expect(matchResponsibilities('React', [later, earlierZeta, earlierAlpha], 3).map(({ agent }) => agent.id))
      .toEqual(['alpha', 'zeta-earlier', 'zeta'])
  })

  it('limits matching candidates without consulting Agent availability', () => {
    const first = createAgent('first', ['React'], '2026-07-31T00:00:00.000Z', 'busy')
    const second = createAgent('second', ['React'], '2026-07-31T00:01:00.000Z', 'offline')

    expect(matchResponsibilities('React', [second, first], 1).map(({ agent }) => agent.id)).toEqual(['first'])
  })
})

function createAgent(
  id: string,
  responsibilities: string[],
  updatedAt = '2026-07-31T00:00:00.000Z',
  status: Agent['status'] = 'idle',
): Agent {
  return {
    id,
    identity: id,
    mentionName: id,
    runtime: 'opencode',
    status,
    capabilityTags: [],
    responsibilities,
    maxConcurrentTasks: 1,
    command: 'opencode',
    args: [],
    model: '',
    env: {},
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt,
  }
}
