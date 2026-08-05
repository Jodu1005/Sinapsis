import type { Server } from 'node:http'
import path from 'node:path'
import { createApp } from './app'
import { LeaseReaper, LeaseReaperLoop } from './application/lease-reaper'
import { SchedulerLoop, TaskScheduler } from './application/task-scheduler'
import { ensureDataDirectory, getServiceConfig } from './config'
import { TaskExecutionCoordinator } from './application/task-execution-coordinator'
import { DreamScheduler } from './application/dream-scheduler'
import type { DreamRunService } from './application/dream-run-service'
import type { WorkspaceRepositories } from './ports/repositories'
import { SystemClock } from './ports/clock'
import { createHumanCapability } from './human-capability'

const config = getServiceConfig()
await ensureDataDirectory(config.dataDir)

const humanCapability = createHumanCapability()
const app = createApp({ databasePath: path.join(config.dataDir, 'sinapsis.sqlite'), humanCapability })
const repositories = app.locals.repositories as WorkspaceRepositories
repositories.recoverOrphanedAgents(new Date())
repositories.recoverDreamMemory(new Date())
const conversationCoordinator = app.locals.conversationCoordinator as { recover?: () => Promise<void> }
await conversationCoordinator.recover?.()
const scheduler = app.locals.scheduler as TaskScheduler
const coordinator = app.locals.executionCoordinator as TaskExecutionCoordinator
coordinator.recover()
const schedulerLoop = new SchedulerLoop(scheduler, repositories, 1_000, () => new Date(), coordinator)
const leaseReaperLoop = new LeaseReaperLoop(new LeaseReaper(repositories, coordinator, repositories))
const dreamRunService = app.locals.dreamRunService as DreamRunService
const dreamScheduler = config.dreamEnabled
  ? new DreamScheduler({
      clock: new SystemClock(),
      time: config.dreamTime,
      timeZone: config.dreamTimeZone,
      trigger: () => { dreamRunService.enqueueAllActive('scheduled') },
    })
  : undefined
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Sinapsis local service listening on http://127.0.0.1:${config.port}`)
  console.log(`Sinapsis human UI: http://localhost:5173/?humanCapability=${encodeURIComponent(humanCapability)}`)
  schedulerLoop.start()
  leaseReaperLoop.start()
  dreamScheduler?.start()
  if (dreamScheduler) console.log(`Dream maintenance scheduled for ${config.dreamTime} (${config.dreamTimeZone})`)
})

let shuttingDown = false

async function closeGracefully(signal: string, service: Server): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.log(`${signal} received, stopping Sinapsis local service.`)
  schedulerLoop.stop()
  dreamScheduler?.stop()
  await dreamRunService.shutdown()
  await leaseReaperLoop.stop()
  await coordinator.shutdown()
  const closeSse = app.locals.closeSse as (() => void) | undefined
  closeSse?.()
  service.closeAllConnections?.()
  await new Promise<void>((resolve) => service.close((error) => {
    const closeDatabase = app.locals.closeDatabase as (() => void) | undefined
    closeDatabase?.()
    const disconnect = process.disconnect
    if (process.connected && disconnect) disconnect.call(process)
    if (error) {
      console.error('Unable to stop Sinapsis local service cleanly.', error)
      process.exitCode = 1
    }
    resolve()
  }))
}

process.once('SIGINT', () => void closeGracefully('SIGINT', server))
process.once('SIGTERM', () => void closeGracefully('SIGTERM', server))
if (typeof process.send === 'function') {
  process.on('message', (message: unknown) => {
    if (message === 'sinapsis:shutdown') void closeGracefully('IPC', server)
  })
}
