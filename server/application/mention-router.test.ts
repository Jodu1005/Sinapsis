import { describe, expect, it } from 'vitest'
import type { Agent } from '../domain/agent'
import { routeMentions } from './mention-router'

describe('routeMentions', () => {
  const newton = createAgent('newton', 'Newton', 'newton')
  const clawd = createAgent('clawd', 'Clawd', 'clawd')

  it('routes one identity mention to its Agent ID', () => {
    expect(routeMentions('@Newton 看一下', [newton, clawd])).toEqual({
      mode: 'direct',
      targetAgentIds: [newton.id],
      unknownMentions: [],
    })
  })

  it('routes a legacy mention name to its Agent ID', () => {
    const frontend = createAgent('frontend', 'Frontend specialist', 'ui')

    expect(routeMentions('@ui 帮忙看看', [frontend])).toEqual({
      mode: 'direct',
      targetAgentIds: [frontend.id],
      unknownMentions: [],
    })
  })

  it('routes distinct targets in their first mention order', () => {
    expect(routeMentions('@Clawd @Newton @Clawd 各自回答', [newton, clawd])).toEqual({
      mode: 'multi_direct',
      targetAgentIds: [clawd.id, newton.id],
      unknownMentions: [],
    })
  })

  it('gives reserved @all priority over Agent aliases', () => {
    const all = createAgent('all', 'all', 'everyone')

    expect(routeMentions('@all 给出意见', [newton, all])).toEqual({
      mode: 'all',
      targetAgentIds: [],
      unknownMentions: [],
    })
  })

  it('still reports unknown handles when @all is present', () => {
    expect(routeMentions('@all @Outsider 一起回答', [newton, clawd])).toEqual({
      mode: 'all',
      targetAgentIds: [],
      unknownMentions: ['Outsider'],
    })
  })

  it('leaves non-member names in unknown mentions', () => {
    expect(routeMentions('@Newton @Outsider 回答', [newton])).toEqual({
      mode: 'direct',
      targetAgentIds: [newton.id],
      unknownMentions: ['Outsider'],
    })
  })

  it('does not treat ordinary text as a mention', () => {
    expect(routeMentions('Newton 看一下', [newton])).toEqual({
      mode: 'ordinary',
      targetAgentIds: [],
      unknownMentions: [],
    })
  })

  it('does not match a mention name inside a longer handle', () => {
    expect(routeMentions('@Newtonian 看一下', [newton])).toEqual({
      mode: 'ordinary',
      targetAgentIds: [],
      unknownMentions: ['Newtonian'],
    })
  })

  it('does not treat email addresses or scoped package names as mentions', () => {
    const scope = createAgent('scope', 'Scope', 'scope')
    const example = createAgent('example', 'Example', 'example')

    expect(routeMentions('联系 foo@example.com、用户@example.com 或 用户@例子.公司，安装 @scope/pkg。', [scope, example])).toEqual({
      mode: 'ordinary',
      targetAgentIds: [],
      unknownMentions: [],
    })
  })

  it('routes a known Agent when Chinese text touches the mention on both sides', () => {
    expect(routeMentions('请@Newton看看', [newton, clawd])).toEqual({
      mode: 'direct',
      targetAgentIds: [newton.id],
      unknownMentions: [],
    })
  })

  it('routes a known Agent when a Latin message touches the mention on the left', () => {
    expect(routeMentions('hello@newton', [newton, clawd])).toEqual({
      mode: 'direct',
      targetAgentIds: [newton.id],
      unknownMentions: [],
    })
  })

  it('routes @all when a Latin message touches the mention on the left', () => {
    expect(routeMentions('hello@all', [newton, clawd])).toEqual({
      mode: 'all',
      targetAgentIds: [],
      unknownMentions: [],
    })
  })

  it('reports unknown mentions at the start of text or after punctuation', () => {
    expect(routeMentions('@Missing 请回答；然后看（@Other）。', [newton])).toEqual({
      mode: 'ordinary',
      targetAgentIds: [],
      unknownMentions: ['Missing', 'Other'],
    })
  })
})

function createAgent(id: string, identity: string, mentionName: string): Agent {
  return {
    id,
    identity,
    mentionName,
    runtime: 'opencode',
    status: 'idle',
    capabilityTags: [],
    responsibilities: [],
    maxConcurrentTasks: 1,
    command: 'opencode',
    args: [],
    model: '',
    env: {},
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  }
}
