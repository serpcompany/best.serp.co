import { describe, expect, it } from 'vitest'
import { d1ErrorCode } from './error-code'

/** A Drizzle failure: the statement and its bound values in the message, D1's error as cause. */
const drizzle = (cause: string) =>
  new Error('Failed query: select * from listings where slug = ?\nparams: typed@example.com', {
    cause: new Error(cause)
  })

describe('d1ErrorCode', () => {
  it('names a failed statement by its SQLite code and a stable reason, never its text', () => {
    for (const [message, code] of [
      [
        'D1_ERROR: too many SQL variables at offset 12: SQLITE_ERROR',
        'SQLITE_ERROR:too_many_variables'
      ],
      [
        'D1_ERROR: UNIQUE constraint failed: listings.slug: SQLITE_CONSTRAINT',
        'SQLITE_CONSTRAINT:constraint_failed'
      ],
      ['D1_ERROR: malformed JSON', 'D1_ERROR:plan_assertion_failed'],
      ['D1_ERROR: no such table: listings: SQLITE_ERROR', 'SQLITE_ERROR:missing_table'],
      ['D1_ERROR: no such column: listings.tagline: SQLITE_ERROR', 'SQLITE_ERROR:missing_column'],
      [
        'D1_ERROR: table listings has no column named tagline: SQLITE_ERROR',
        'SQLITE_ERROR:missing_column'
      ],
      ['D1 DB is overloaded. Requests queued for too long.', 'UNKNOWN:overloaded'],
      ['D1_ERROR: Network connection lost.', 'D1_ERROR:connection_lost'],
      [
        'D1 DB storage operation exceeded timeout which caused object to be reset.',
        'UNKNOWN:storage_reset'
      ],
      ['D1_ERROR: D1 DB reset because its code was updated.', 'D1_ERROR:storage_reset'],
      ['D1_ERROR: the operation timed out', 'D1_ERROR:timeout'],
      ['D1_ERROR: something new', 'D1_ERROR']
    ]) {
      const error = drizzle(message)
      expect(d1ErrorCode(error), message).toBe(code)
      expect(d1ErrorCode(error)).not.toContain('typed@example.com')
    }
  })

  it('is UNKNOWN for anything that is not a D1 failure', () => {
    expect(d1ErrorCode(new TypeError('Cannot read properties of undefined'))).toBe('UNKNOWN')
    expect(d1ErrorCode('typed@example.com')).toBe('UNKNOWN')
    expect(d1ErrorCode(undefined)).toBe('UNKNOWN')
  })
})
