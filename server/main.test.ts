import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('local service shutdown', () => {
  let child: ChildProcess | undefined
  let temporaryDirectory: string | undefined

  afterEach(async () => {
    child?.kill('SIGKILL')
    child = undefined
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
    temporaryDirectory = undefined
  })

  it('closes SSE clients before waiting for the HTTP server to close', async () => {
    const port = await reservePort()
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'sinapsis-shutdown-'))
    child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['server/main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, SINAPSIS_PORT: String(port), SINAPSIS_DATA_DIR: temporaryDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await waitForOutput(child.stdout!, 'Sinapsis local service listening')
    const response = await fetch(`http://127.0.0.1:${port}/events`)
    expect(response.status).toBe(200)

    child.kill('SIGTERM')

    await expect(waitForExit(child, 500)).resolves.toBe(0)
    await response.body?.cancel()
  })
})

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function waitForOutput(output: NodeJS.ReadableStream, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Did not receive: ${expected}`)), 2_000)
    output.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes(expected)) return
      clearTimeout(timeout)
      resolve()
    })
  })
}

function waitForExit(process: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs)
    process.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}
