import { describe, expect, it } from 'vitest'
import { latestInstant, toInstant } from './instants'

describe('D1 times (#218)', () => {
  it('reads both stored formats and epoch milliseconds as ISO instants', () => {
    expect(toInstant('2026-10-06 08:12:00')).toBe('2026-10-06T08:12:00.000Z')
    expect(toInstant('2026-10-06T08:12:00.000Z')).toBe('2026-10-06T08:12:00.000Z')
    expect(toInstant('2026-05-16')).toBe('2026-05-16T00:00:00.000Z')
    expect(toInstant(1791244800000)).toBe('2026-10-06T00:00:00.000Z')
    expect(toInstant('not a time')).toBeNull()
  })

  it('takes the latest across formats, ignoring what does not parse', () => {
    // As text, '2026-10-06 09:00:00' sorts before '2026-10-06T08:00:00Z'; as times it is later.
    expect(latestInstant('2026-10-06T08:00:00.000Z', '2026-10-06 09:00:00')).toBe(
      '2026-10-06T09:00:00.000Z'
    )
    expect(latestInstant(null, '', 'nope', '2026-01-01')).toBe('2026-01-01T00:00:00.000Z')
    expect(latestInstant(null, undefined)).toBeNull()
  })
})
