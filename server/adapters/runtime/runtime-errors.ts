import type { RuntimeErrorCode } from '../../ports/runtime'

const sessionLostPatterns = [
  /session not found/i,
  /no conversation found with session id/i,
  /no session found/i,
  /unknown session/i,
  /invalid session/i,
]

export function classifyRuntimeError(message: string): RuntimeErrorCode {
  return isSessionLostError(message) ? 'session_lost' : 'runtime_failure'
}

export function isSessionLostError(message: string): boolean {
  return sessionLostPatterns.some((pattern) => pattern.test(message))
}
