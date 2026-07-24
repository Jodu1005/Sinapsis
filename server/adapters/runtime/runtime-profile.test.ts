import { describe, expect, it } from 'vitest'
import { CommandRuntimeAvailabilityDetector, resolveRuntimeProfile } from './runtime-profile'

describe('CommandRuntimeAvailabilityDetector', () => {
  it('reports a version-probed executable as unverified for task execution', async () => {
    const detector = new CommandRuntimeAvailabilityDetector()

    await expect(detector.detect(resolveRuntimeProfile('opencode', { command: process.execPath })))
      .resolves.toEqual({ executable: 'available', taskExecution: 'unverified' })
  })
})
