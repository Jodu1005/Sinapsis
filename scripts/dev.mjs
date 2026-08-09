import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const capability = randomBytes(32).toString('base64url')
const environment = {
  ...process.env,
  SINAPSIS_HUMAN_CAPABILITY: capability,
  SINAPSIS_DEV_HUMAN_CAPABILITY: capability,
}
const children = [
  spawn('npm', ['run', 'dev:api'], { env: environment, stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npm', ['run', 'dev:web'], { env: environment, stdio: 'inherit', shell: process.platform === 'win32' }),
]

let stopping = false
const stop = (signal) => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill(signal)
}

process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))

for (const child of children) {
  child.once('exit', (code) => {
    if (!stopping) {
      stop('SIGTERM')
      process.exitCode = code ?? 1
    }
  })
}
