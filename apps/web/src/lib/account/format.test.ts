import { describe, expect, it } from 'vitest'
import { formatDay, formatFull, formatShort, formatStamp, formatWhen } from './format'

describe('account dates (UTC, as the #70 mockups write them)', () => {
  it('formats each shape', () => {
    const iso = '2026-10-04T15:02:09.000Z'
    expect(formatStamp(iso)).toBe('Sun, Oct 4, 15:02 UTC')
    expect(formatDay(iso)).toBe('Sun, Oct 4, 2026')
    expect(formatFull('2026-10-05T09:14:00.000Z')).toBe('Mon, Oct 5, 2026, 09:14 UTC')
    expect(formatShort(iso)).toBe('Oct 4')
    expect(formatWhen('2026-10-05T00:04:00.000Z')).toBe('Oct 5, 00:04')
    expect(formatStamp(null)).toBe('')
    expect(formatDay('not a date')).toBe('')
  })
})
