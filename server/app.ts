import express, { type Express } from 'express'
import path from 'node:path'
import { SseDomainEventPublisher } from './adapters/sse/sse-domain-event-publisher'
import { createSqliteDatabase } from './adapters/sqlite/database'
import { SqliteRepositories } from './adapters/sqlite/sqlite-repositories'
import { getServiceConfig } from './config'

export interface CreateAppOptions {
  databasePath?: string
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express()
  const databasePath = options.databasePath ?? defaultDatabasePath()
  const database = createSqliteDatabase(databasePath)
  const eventPublisher = new SseDomainEventPublisher()
  const repositories = new SqliteRepositories(database, eventPublisher)

  app.locals.closeDatabase = () => database.close()

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' })
  })

  app.get('/api/bootstrap', (_request, response) => {
    response.json(repositories.getBootstrap())
  })

  app.get('/events', (request, response) => {
    eventPublisher.handle(request, response)
  })

  return app
}

function defaultDatabasePath(): string {
  if (process.env.NODE_ENV === 'test') {
    return ':memory:'
  }

  return path.join(getServiceConfig().dataDir, 'sinapsis.sqlite')
}
