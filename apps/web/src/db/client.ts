import type { SQL } from 'drizzle-orm'
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

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

/** D1 and SQLite failure messages mapped to a stable reason (D1 limits: docs/DATA_MODEL.md). */
const D1_ERROR_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/too many SQL variables|variable number must be between/iu, 'too_many_variables'],
  [/LIKE or GLOB pattern too complex/iu, 'like_pattern_too_long'],
  [/statement too long|SQLITE_TOOBIG|string or blob too big/iu, 'too_big'],
  [/Expression tree is too large/iu, 'expression_too_deep'],
  [/too many terms in compound SELECT/iu, 'compound_select_too_large'],
  [/too many arguments on function/iu, 'too_many_function_arguments'],
  [/malformed JSON/iu, 'plan_assertion_failed'],
  [/constraint failed|SQLITE_CONSTRAINT/iu, 'constraint_failed'],
  [/timed? ?out|timeout/iu, 'timeout']
]

/**
 * A loggable code for a failed D1 statement: the SQLite result code and a stable reason, for
 * example `SQLITE_ERROR:too_many_variables`. Only the code is returned, never the message,
 * which Drizzle extends with the SQL text and its bound values.
 */
export function d1ErrorCode(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      messages.push(current.message)
      current = (current as Error & { cause?: unknown }).cause
    } else {
      messages.push(String(current))
      break
    }
  }
  const text = messages.join('\n')
  const sqliteCode =
    /\bSQLITE_[A-Z_]+\b/u.exec(text)?.[0] ?? /\bD1_[A-Z_]+\b/u.exec(text)?.[0] ?? 'UNKNOWN'
  const reason = D1_ERROR_REASONS.find(([pattern]) => pattern.test(text))?.[1]
  return reason ? `${sqliteCode}:${reason}` : sqliteCode
}

export function createDatabase(binding: D1Database): Database {
  return {
    binding,
    database: drizzle(binding, { schema })
  }
}
