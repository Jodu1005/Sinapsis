import type { Server } from 'node:http'
import { createApp } from './app'
import { ensureDataDirectory, getServiceConfig } from './config'

const config = getServiceConfig()
await ensureDataDirectory(config.dataDir)

const server = createApp().listen(config.port, '127.0.0.1', () => {
  console.log(`Sinapsis local service listening on http://127.0.0.1:${config.port}`)
})

let shuttingDown = false

function closeGracefully(signal: NodeJS.Signals, service: Server): void {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.log(`${signal} received, stopping Sinapsis local service.`)
  service.close((error) => {
    if (error) {
      console.error('Unable to stop Sinapsis local service cleanly.', error)
      process.exitCode = 1
    }
  })
}

process.once('SIGINT', () => closeGracefully('SIGINT', server))
process.once('SIGTERM', () => closeGracefully('SIGTERM', server))
