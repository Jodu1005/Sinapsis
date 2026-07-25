import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const dataDir = process.env.SINAPSIS_DATA_DIR?.trim() || path.join(homedir(), '.sinapsis')
const defaults = [
  { runtime: 'opencode', command: 'opencode' },
  { runtime: 'pi', command: 'pi' },
  { runtime: 'claude-code', command: 'claude' },
]
const configured = readConfiguredCommands(path.join(dataDir, 'sinapsis.sqlite'))
const runtimes = selectRuntimeCommands(configured)

const results = await Promise.all(runtimes.map(checkCommand))
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), dataDir, runtimes: results }, null, 2))

function readConfiguredCommands(databasePath) {
  if (!existsSync(databasePath)) return []
  try {
    const { DatabaseSync } = requireNodeSqlite()
    const database = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return database.prepare('SELECT id, mention_name, runtime, command FROM agents ORDER BY created_at, id').all()
        .map((row) => ({
          agentId: row.id,
          mentionName: row.mention_name,
          runtime: row.runtime,
          command: row.command,
        }))
    } finally {
      database.close()
    }
  } catch {
    return []
  }
}

function selectRuntimeCommands(configured) {
  const configuredRuntimes = new Set(configured.map(({ runtime }) => runtime))
  const candidates = [
    ...configured,
    ...defaults.filter(({ runtime }) => !configuredRuntimes.has(runtime)),
  ]
  const unique = new Map()
  for (const candidate of candidates) {
    const key = `${candidate.runtime}\u0000${candidate.command}`
    const existing = unique.get(key)
    if (existing) {
      if (candidate.agentId) {
        existing.agents.push({ id: candidate.agentId, mentionName: candidate.mentionName })
      }
      continue
    }
    unique.set(key, {
      runtime: candidate.runtime,
      command: candidate.command,
      agents: candidate.agentId ? [{ id: candidate.agentId, mentionName: candidate.mentionName }] : [],
    })
  }
  return [...unique.values()]
}

function requireNodeSqlite() {
  return process.getBuiltinModule('node:sqlite')
}

function checkCommand({ runtime, command, agents }) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = []
    const errors = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ runtime, command, agents, ...result })
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish({ status: 'unhealthy', detail: 'version check timed out' })
    }, 2_000)
    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.once('error', (error) => finish(error.code === 'ENOENT'
      ? { status: 'missing', detail: 'executable not found' }
      : { status: 'unhealthy', detail: error.message }))
    child.once('close', (code) => {
      const detail = Buffer.concat(output).toString('utf8').trim() || Buffer.concat(errors).toString('utf8').trim()
      finish(code === 0 ? { status: 'available', detail } : { status: 'unhealthy', detail: detail || `exited with ${code ?? 'unknown'}` })
    })
  })
}
