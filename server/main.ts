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
const schedulerLoop = new SchedulerLoop(new TaskScheduler(repositories), repositories)
const leaseReaperLoop = new LeaseReaperLoop(new LeaseReaper(repositories, new NoopProcessTerminator(), repositories))
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Sinapsis local service listening on http://127.0.0.1:${config.port}`)
  schedulerLoop.start()
  leaseReaperLoop.start()
})

let shuttingDown = false

function closeGracefully(signal: NodeJS.Signals, service: Server): void {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.log(`${signal} received, stopping Sinapsis local service.`)
  schedulerLoop.stop()
  leaseReaperLoop.stop()
  service.close((error) => {
    const closeSse = app.locals.closeSse as (() => void) | undefined
    const closeDatabase = app.locals.closeDatabase as (() => void) | undefined
    closeSse?.()
    closeDatabase?.()
    if (error) {
      console.error('Unable to stop Sinapsis local service cleanly.', error)
      process.exitCode = 1
    }
  })
}

process.once('SIGINT', () => closeGracefully('SIGINT', server))
process.once('SIGTERM', () => closeGracefully('SIGTERM', server))
