/**
 * When the badge program (serpcompany/best.serp.co#59, #66) runs, as Cron Triggers in
 * `apps/web/wrangler.jsonc` (`triggers.crons`, all UTC) and as the instants its D1 queries
 * compare against. `schedule.test.ts` keeps the expressions and the arithmetic in step.
 *
 * - The **weekly** trigger opens a cycle: every listing in the program is due for one check
 *   from that instant on.
 * - The **daily** trigger opens a confirmation window: a warning (a weekly conclusive miss) at
 *   least `BADGE_CONFIRMATION_MIN_HOURS` older than the window's start is rechecked once in it,
 *   so the recheck lands about 24 hours after the warning.
 * - The **hourly** trigger (shared with the draft job) continues both in batches, so a large
 *   cycle is spread over many invocations instead of one.
 *
 * The weekly and daily minutes avoid the top of the hour, when the hourly trigger fires.
 */

/** Mondays at 03:15 UTC. */
export const BADGE_WEEKLY_CRON = '15 3 * * 1'
/** Every day at 03:45 UTC. */
export const BADGE_DAILY_CRON = '45 3 * * *'

const WEEKLY = { day: 1, hour: 3, minute: 15 } as const
const DAILY = { hour: 3, minute: 45 } as const
/** A warning is rechecked by the first daily window that starts at least this long after it. */
export const BADGE_CONFIRMATION_MIN_HOURS = 20

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function utcDayAt(time: number, hour: number, minute: number): number {
  const date = new Date(time)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute)
}

function instant(value: Date | string): number {
  const time = typeof value === 'string' ? Date.parse(value) : value.getTime()
  if (Number.isNaN(time)) throw new Error('The badge schedule needs a valid instant.')
  return time
}

/** The start of the weekly cycle `now` falls in: the latest weekly trigger at or before it. */
export function badgeCycleStart(now: Date | string): Date {
  const time = instant(now)
  const sinceMonday = (new Date(time).getUTCDay() - WEEKLY.day + 7) % 7
  let start = utcDayAt(time, WEEKLY.hour, WEEKLY.minute) - sinceMonday * DAY
  if (start > time) start -= 7 * DAY
  return new Date(start)
}

/** The start of the confirmation window `now` falls in: the latest daily trigger at or before it. */
export function badgeDailyStart(now: Date | string): Date {
  const time = instant(now)
  let start = utcDayAt(time, DAILY.hour, DAILY.minute)
  if (start > time) start -= DAY
  return new Date(start)
}

/** Warnings at or before this instant are due for their recheck in the current window. */
export function badgeConfirmationDueBefore(now: Date | string): Date {
  return new Date(badgeDailyStart(now).getTime() - BADGE_CONFIRMATION_MIN_HOURS * HOUR)
}

/** When the recheck of a warning recorded at `warnedAt` runs (what the email promises). */
export function badgeRecheckAt(warnedAt: Date | string): Date {
  const earliest = instant(warnedAt) + BADGE_CONFIRMATION_MIN_HOURS * HOUR
  const start = badgeDailyStart(new Date(earliest)).getTime()
  return new Date(start === earliest ? start : start + DAY)
}
