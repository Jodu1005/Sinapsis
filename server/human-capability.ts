import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'

export const humanCapabilityHeader = 'x-sinapsis-human-capability'

export function createHumanCapability(): string {
  return randomBytes(32).toString('base64url')
}

export function requireHumanCapability(expected: string): RequestHandler {
  if (!expected.trim()) throw new Error('Human capability must not be empty.')
  const expectedDigest = digest(expected)

  return (request, response, next) => {
    const provided = request.get(humanCapabilityHeader)
    if (!provided || !timingSafeEqual(expectedDigest, digest(provided))) {
      response.status(403).json({ error: 'A local human capability is required.' })
      return
    }
    next()
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
