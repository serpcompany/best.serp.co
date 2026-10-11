import type { SQL } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export { d1ErrorCode } from './error-code'

export interface Database {
  binding: D1Database
  database: DrizzleD1Database<typeof schema>
}

export interface CompiledQuery {
  toSQL(): { params: unknown[]; sql: string }
}

/**
 * Execute a typed, parameterized statement through the shared Drizzle client while
 * retaining D1's per-statement metadata. Drizzle's mapped `all()` API intentionally
 * returns rows only, so Catalog queries that must report rows read/written use the
 * driver's raw response through `run()`.
 */
export async function runQuery<T>(
  client: Database,
  query: CompiledQuery | SQL<T>
): Promise<D1Result<T>> {
  if ('toSQL' in query) {
    const compiled = query.toSQL()
    return client.binding
      .prepare(compiled.sql)
      .bind(...compiled.params)
      .all<T>()
  }
  return (await client.database.run(query)) as D1Result<T>
}

/**
 * Execute typed, parameterized statements as one D1 batch: one round trip to D1, where they run
 * in order, each result keeping its own metadata. A listing page's detail, related listings and
 * neighbours are read this way (#378).
 */
export async function runBatch(
  client: Database,
  queries: readonly CompiledQuery[]
): Promise<D1Result<unknown>[]> {
  if (queries.length === 0) throw new Error('A batch needs at least one statement.')
  return client.binding.batch(
    queries.map(query => {
      const compiled = query.toSQL()
      return client.binding.prepare(compiled.sql).bind(...compiled.params)
    })
  )
}

export function createDatabase(binding: D1Database): Database {
  return {
    binding,
    database: drizzle(binding, { schema })
  }
}
