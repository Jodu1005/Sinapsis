import { DatabaseSync } from 'node:sqlite'
import { migrateSchema } from './schema'

export interface SqliteDatabase {
  database: DatabaseSync
  transaction<T>(work: () => T): T
  afterCommit(work: () => void): void
  close(): void
}

export function createSqliteDatabase(filename: string): SqliteDatabase {
  const database = new DatabaseSync(filename)
  try {
    migrateSchema(database)
  } catch (error) {
    database.close()
    throw error
  }
  let transactionDepth = 0
  let afterCommitCallbacks: Array<() => void> | undefined

  return {
    database,
    transaction<T>(work: () => T): T {
      const isOutermostTransaction = transactionDepth === 0
      if (isOutermostTransaction) {
        afterCommitCallbacks = []
        database.exec('BEGIN IMMEDIATE')
      }

      transactionDepth += 1
      let result: T
      try {
        result = work()
        transactionDepth -= 1
      } catch (error) {
        transactionDepth -= 1
        if (isOutermostTransaction) {
          afterCommitCallbacks = undefined
          database.exec('ROLLBACK')
        }
        throw error
      }

      if (!isOutermostTransaction) {
        return result
      }

      try {
        database.exec('COMMIT')
      } catch (error) {
        afterCommitCallbacks = undefined
        database.exec('ROLLBACK')
        throw error
      }

      const committedCallbacks = afterCommitCallbacks ?? []
      afterCommitCallbacks = undefined
      for (const callback of committedCallbacks) {
        callback()
      }
      return result
    },
    afterCommit(work: () => void): void {
      if (transactionDepth === 0 || !afterCommitCallbacks) {
        throw new Error('afterCommit must be registered inside a database transaction.')
      }

      afterCommitCallbacks.push(work)
    },
    close(): void {
      database.close()
    },
  }
}
