import { describe, expect, it } from 'vitest'
import { TaskReviewService } from './task-review-service'

describe('TaskReviewService', () => {
  it('does not provide a merge operation in prototype zero', () => {
    expect(() => new TaskReviewService({} as never).merge('task-1')).toThrow('第一版只记录验收')
  })
})
