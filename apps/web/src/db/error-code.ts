/**
 * Stable codes for failed D1 statements, for logs (#211). Import-free, so the Worker entry and
 * `src/instrumentation.ts` can log a code without loading Drizzle or the schema.
 */

/** D1 and SQLite failure messages mapped to a stable reason (D1 limits: docs/data-model.md). */
const D1_ERROR_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/too many SQL variables|variable number must be between/iu, 'too_many_variables'],
  [/LIKE or GLOB pattern too complex/iu, 'like_pattern_too_long'],
  [/statement too long|SQLITE_TOOBIG|string or blob too big/iu, 'too_big'],
  [/Expression tree is too large/iu, 'expression_too_deep'],
  [/too many terms in compound SELECT/iu, 'compound_select_too_large'],
  [/too many arguments on function/iu, 'too_many_function_arguments'],
  [/malformed JSON/iu, 'plan_assertion_failed'],
  [/constraint failed|SQLITE_CONSTRAINT/iu, 'constraint_failed'],
  // Schema drift: a migration not applied yet, or applied out of order.
  [/no such table/iu, 'missing_table'],
  [/no such column|has no column named/iu, 'missing_column'],
  // D1's transient failures (D1 docs, "Errors"): worth a retry.
  [/overloaded/iu, 'overloaded'],
  [/network connection lost/iu, 'connection_lost'],
  [/object to be reset|DB reset because/iu, 'storage_reset'],
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
