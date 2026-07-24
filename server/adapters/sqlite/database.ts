import { DatabaseSync } from 'node:sqlite'
import { migrateSchema } from './schema'

export interface SqliteDatabase {
  database: DatabaseSync
  transaction<T>(work: () => T): T
  close(): void
}

export function createSqliteDatabase(filename: string): SqliteDatabase {
  const database = new DatabaseSync(filename)
  migrateSchema(database)

  return {
    database,
    transaction<T>(work: () => T): T {
      if (database.isTransaction) {
        return work()
      }

      database.exec('BEGIN IMMEDIATE')
      try {
        const result = work()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    close(): void {
      database.close()
    },
  }
}
