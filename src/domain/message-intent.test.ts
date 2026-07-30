import { describe, expect, it } from 'vitest'
import type { AgentView } from './workspace-view'
import { parseMessageIntent } from './message-intent'

const agents = [
  { id: 'agent-pi', identity: 'newton', mentionName: 'dev' },
  { id: 'agent-opencode', identity: 'ada', mentionName: 'frontend' },
] as AgentView[]

describe('parseMessageIntent', () => {
  it('keeps ordinary chat messages intact', () => {
    expect(parseMessageIntent('大家同步一下。', agents)).toEqual({ kind: 'message', body: '大家同步一下。' })
  })

  it('parses a task command without a direct agent', () => {
    expect(parseMessageIntent('/task 修复按钮', agents)).toMatchObject({
      kind: 'task',
      title: '修复按钮',
      directAgentId: undefined,
    })
  })

  it('resolves an agent mention at the beginning of task content', () => {
    expect(parseMessageIntent('/task @newton 修复按钮', agents)).toMatchObject({
      kind: 'task',
      title: '修复按钮',
      directAgentId: 'agent-pi',
    })
  })

  it('keeps legacy handles compatible while preferring Agent names', () => {
    expect(parseMessageIntent('/task @dev 修复按钮', agents)).toMatchObject({ directAgentId: 'agent-pi' })
  })

  it('reports an unknown task-agent mention', () => {
    expect(parseMessageIntent('/task @missing 修复按钮', agents)).toEqual({
      kind: 'error',
      message: '找不到 Agent @missing。',
    })
  })

  it('requires task content after a direct agent mention', () => {
    expect(parseMessageIntent('/task @newton', agents)).toEqual({
      kind: 'error',
      message: '请补充任务内容。',
    })
  })
})
