import { describe, expect, it } from 'vitest'
import { CommandRuntimeAvailabilityDetector, resolveRuntimeProfile } from './runtime-profile'

describe('CommandRuntimeAvailabilityDetector', () => {
  it('treats manual arguments as additions to the fixed runtime protocol', () => {
    expect(resolveRuntimeProfile('opencode', { args: ['--model', 'anthropic/claude-sonnet-4'] }).args)
      .toEqual(['run', '--model', 'anthropic/claude-sonnet-4'])
    expect(resolveRuntimeProfile('pi', { args: ['--no-session'] }).args)
      .toEqual(['--mode', 'rpc', '--no-session'])
  })

  it('reports a version-probed executable as unverified for task execution', async () => {
    const detector = new CommandRuntimeAvailabilityDetector()

    await expect(detector.detect(resolveRuntimeProfile('opencode', { command: process.execPath })))
      .resolves.toEqual({ executable: 'available', taskExecution: 'unverified' })
  })
})
