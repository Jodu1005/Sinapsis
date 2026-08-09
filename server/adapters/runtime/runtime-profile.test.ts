import { describe, expect, it } from 'vitest'
import { CommandRuntimeAvailabilityDetector, resolveRuntimeProfile } from './runtime-profile'
import { ValidationError } from '../../application/workspace-service'

describe('CommandRuntimeAvailabilityDetector', () => {
  it('treats manual arguments as additions to the fixed runtime protocol', () => {
    expect(resolveRuntimeProfile('opencode', { args: ['--model', 'anthropic/claude-sonnet-4'] }).args)
      .toEqual(['run', '--model', 'anthropic/claude-sonnet-4'])
    expect(resolveRuntimeProfile('opencode-acp', { args: ['--model', 'anthropic/claude-sonnet-4'] }).args)
      .toEqual(['acp', '--model', 'anthropic/claude-sonnet-4'])
    expect(resolveRuntimeProfile('pi', { args: ['--no-session'] }).args)
      .toEqual(['--mode', 'rpc', '--no-session'])
  })

  it.each([
    ['--mode', 'json'],
    ['--mode=json'],
  ])('rejects Pi arguments that override its RPC transport: %j', (...args) => {
    expect(() => resolveRuntimeProfile('pi', { args })).toThrow(new ValidationError('Pi runtime arguments cannot override --mode rpc.'))
  })

  it.each([
    ['run'],
    ['serve'],
  ])('rejects OpenCode command-subcommand conflicts: %j', (...args) => {
    expect(() => resolveRuntimeProfile('opencode', { args })).toThrow(new ValidationError('OpenCode runtime arguments cannot include command subcommands.'))
  })

  it('reports a version-probed executable as unverified for task execution', async () => {
    const detector = new CommandRuntimeAvailabilityDetector()

    await expect(detector.detect(resolveRuntimeProfile('opencode', { command: process.execPath })))
      .resolves.toEqual({ executable: 'available', taskExecution: 'unverified' })
  })
})
