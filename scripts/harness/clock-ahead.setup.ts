import { afterAll, beforeEach, vi } from 'vitest'

/**
 * `pnpm test:clock-ahead` (#450) runs the Vitest projects with the clock a year ahead, so a test
 * that measures a fixed fixture date against the real clock fails today, not on the day that date
 * passes (#447). Only `Date` is faked, and it keeps advancing; timers stay real. Each test starts
 * from the shifted clock, and a test's own `vi.useFakeTimers()`/`vi.setSystemTime()` still wins.
 */
const days = Number(process.env.VITEST_CLOCK_AHEAD_DAYS)
if (!Number.isInteger(days) || days <= 0) {
  throw new Error('VITEST_CLOCK_AHEAD_DAYS must be a positive whole number of days.')
}

const shift = () =>
  vi.useFakeTimers({
    toFake: ['Date'],
    shouldAdvanceTime: true,
    now: vi.getRealSystemTime() + days * 86_400_000
  })

shift()
beforeEach(shift)
afterAll(() => {
  vi.useRealTimers()
})
