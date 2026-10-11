import type { SQL } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export { d1ErrorCode } from './error-code'

export interface Database {
  /**
   * The `DB` binding, or a session of it (`createSessionDatabase`), which only public catalog
   * reads use (#382). Statements run through `prepare` and `batch`, which both have.
   */
  binding: D1Database | D1DatabaseSession
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

/**
 * A database that reads through a D1 session (#382). With read replication on, a session reads
 * from any copy of the database at least as new as where it started (its constraint or bookmark),
 * and each statement sees at least what the session's earlier statements saw. Without replication,
 * every statement runs on the primary, as through the binding, with no extra round trip. Only the
 * public catalog reads this way; writes and signed-in flows use `createDatabase`, which always
 * reads the primary. Drizzle sends statements through `prepare` and `batch` only, which a session
 * has, so its D1 driver runs on one unchanged.
 */
export function createSessionDatabase(session: D1DatabaseSession): Database {
  return {
    binding: session,
    database: drizzle(session as unknown as D1Database, { schema })
  }
}

/** Where D1 ran a statement, as remote D1 reports it (#382); nothing locally. */
export function servedBy(meta: unknown): { servedByPrimary?: boolean; servedByRegion?: string } {
  if (!meta || typeof meta !== 'object') return {}
  const { served_by_primary: primary, served_by_region: region } = meta as Record<string, unknown>
  return {
    ...(typeof primary === 'boolean' ? { servedByPrimary: primary } : {}),
    ...(typeof region === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(region)
      ? { servedByRegion: region }
      : {})
  }
}
