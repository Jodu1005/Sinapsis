import type { Server } from 'node:http'
import { createApp } from './app'
import { LeaseReaper, LeaseReaperLoop } from './application/lease-reaper'
import { SchedulerLoop, TaskScheduler } from './application/task-scheduler'
import { ensureDataDirectory, getServiceConfig } from './config'
import { NoopProcessTerminator } from './ports/process-terminator'
import type { WorkspaceRepositories } from './ports/repositories'

const config = getServiceConfig()
await ensureDataDirectory(config.dataDir)

const app = createApp()
const repositories = app.locals.repositories as WorkspaceRepositories
const scheduler = app.locals.scheduler as TaskScheduler
const schedulerLoop = new SchedulerLoop(scheduler, repositories)
const leaseReaperLoop = new LeaseReaperLoop(new LeaseReaper(repositories, new NoopProcessTerminator(), repositories))
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Sinapsis local service listening on http://127.0.0.1:${config.port}`)
  schedulerLoop.start()
  leaseReaperLoop.start()
})

let shuttingDown = false

async function closeGracefully(signal: NodeJS.Signals, service: Server): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.log(`${signal} received, stopping Sinapsis local service.`)
  schedulerLoop.stop()
  await leaseReaperLoop.stop()
  const closeSse = app.locals.closeSse as (() => void) | undefined
  closeSse?.()
  await new Promise<void>((resolve) => service.close((error) => {
    const closeDatabase = app.locals.closeDatabase as (() => void) | undefined
    closeDatabase?.()
    if (error) {
      console.error('Unable to stop Sinapsis local service cleanly.', error)
      process.exitCode = 1
    }
    resolve()
  }))
}

process.once('SIGINT', () => void closeGracefully('SIGINT', server))
process.once('SIGTERM', () => void closeGracefully('SIGTERM', server))
