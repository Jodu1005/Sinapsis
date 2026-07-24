import { describe, expect, it } from 'vitest'
import { LfJsonlParser } from './lf-jsonl-parser'

describe('LfJsonlParser', () => {
  it('frames only on LF and leaves an incomplete trailing record for the next chunk', () => {
    const parser = new LfJsonlParser()

    expect(parser.push('{"event":"one"}\r\n{"event":"two"}')).toEqual([
      { raw: '{"event":"one"}', value: { event: 'one' } },
    ])
    expect(parser.push('\n')).toEqual([
      { raw: '{"event":"two"}', value: { event: 'two' } },
    ])
  })

  it('keeps unicode line separators inside JSON string values', () => {
    const parser = new LfJsonlParser()

    expect(parser.push('{"text":"left\u2028middle\u2029right"}\n')).toEqual([
      {
        raw: '{"text":"left\u2028middle\u2029right"}',
        value: { text: 'left\u2028middle\u2029right' },
      },
    ])
  })

  it('returns invalid JSON as a raw record instead of throwing away runtime evidence', () => {
    const parser = new LfJsonlParser()

    expect(parser.push('not json\n')).toEqual([
      { raw: 'not json', value: undefined },
    ])
  })
})
