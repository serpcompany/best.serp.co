import { describe, expect, it } from 'vitest'
import {
  BADGE_DAILY_CRON,
  BADGE_WEEKLY_CRON,
  badgeConfirmationDueBefore,
  badgeCycleStart,
  badgeDailyStart,
  badgeRecheckAt
} from './schedule'

/** Minute, hour, and weekday of a five-field cron expression with fixed or `*` fields. */
function fires(expression: string, instant: Date): boolean {
  const [minute, hour, day, month, weekday] = expression.split(' ')
  const matches = (field: string | undefined, value: number) =>
    field === '*' || Number(field) === value
  return (
    matches(minute, instant.getUTCMinutes()) &&
    matches(hour, instant.getUTCHours()) &&
    matches(day, instant.getUTCDate()) &&
    matches(month, instant.getUTCMonth() + 1) &&
    matches(weekday, instant.getUTCDay()) &&
    instant.getUTCSeconds() === 0 &&
    instant.getUTCMilliseconds() === 0
  )
}

describe('badge schedule', () => {
  it('starts each cycle and window exactly when its Cron Trigger fires', () => {
    const now = new Date('2026-10-08T17:20:00.000Z') // a Thursday
    const cycle = badgeCycleStart(now)
    expect(cycle.toISOString()).toBe('2026-10-05T03:15:00.000Z')
    expect(fires(BADGE_WEEKLY_CRON, cycle)).toBe(true)
    const window = badgeDailyStart(now)
    expect(window.toISOString()).toBe('2026-10-08T03:45:00.000Z')
    expect(fires(BADGE_DAILY_CRON, window)).toBe(true)
    // The trigger instant itself belongs to the new cycle and window; a minute before does not.
    expect(badgeCycleStart(cycle)).toEqual(cycle)
    expect(badgeCycleStart(new Date(cycle.getTime() - 60_000)).toISOString()).toBe(
      '2026-09-28T03:15:00.000Z'
    )
    expect(badgeDailyStart(new Date(window.getTime() - 60_000)).toISOString()).toBe(
      '2026-10-07T03:45:00.000Z'
    )
    // Every hourly instant of a week maps to the latest trigger at or before it.
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      const instant = new Date(Date.parse('2026-10-05T00:00:00.000Z') + hour * 3_600_000)
      expect(badgeCycleStart(instant).getTime()).toBeLessThanOrEqual(instant.getTime())
      expect(fires(BADGE_WEEKLY_CRON, badgeCycleStart(instant))).toBe(true)
      expect(fires(BADGE_DAILY_CRON, badgeDailyStart(instant))).toBe(true)
      expect(instant.getTime() - badgeDailyStart(instant).getTime()).toBeLessThan(86_400_000)
    }
  })

  it('rechecks a warning in the first window at least 20 hours later, about a day after it', () => {
    // Warned in the weekly run (Monday 03:15) or its first hourly batches: Tuesday's window.
    for (const warnedAt of ['2026-10-05T03:15:00.000Z', '2026-10-05T07:00:00.000Z']) {
      expect(badgeRecheckAt(warnedAt).toISOString()).toBe('2026-10-06T03:45:00.000Z')
    }
    // Warned later that day: Wednesday's window (never sooner than 20 hours).
    expect(badgeRecheckAt('2026-10-05T07:46:00.000Z').toISOString()).toBe(
      '2026-10-07T03:45:00.000Z'
    )
    expect(badgeRecheckAt('2026-10-05T07:45:00.000Z').toISOString()).toBe(
      '2026-10-06T03:45:00.000Z'
    )
  })

  it('makes a warning due in exactly the window its email promises', () => {
    for (const warnedAt of [
      '2026-10-05T03:15:00.000Z',
      '2026-10-05T07:45:00.000Z',
      '2026-10-05T07:45:00.001Z',
      '2026-10-05T23:59:00.000Z'
    ]) {
      const recheck = badgeRecheckAt(warnedAt)
      const dueIn = (instant: Date) =>
        badgeConfirmationDueBefore(instant).getTime() >= Date.parse(warnedAt)
      expect(dueIn(recheck), warnedAt).toBe(true)
      expect(dueIn(new Date(recheck.getTime() - 1)), warnedAt).toBe(false)
    }
  })

  it('refuses an invalid instant', () => {
    expect(() => badgeCycleStart('not a date')).toThrow(/valid instant/u)
  })
})
