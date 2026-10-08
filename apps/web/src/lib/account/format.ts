/**
 * Dates as the #70 account mockups write them, always in UTC (the emails do the same):
 * "Sun, Oct 4, 15:02 UTC", "Sun, Oct 4, 2026", "Oct 4", "Oct 5, 09:14".
 */

function parts(iso: string | null | undefined, options: Intl.DateTimeFormatOptions) {
  if (!iso) return null
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return null
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { ...options, hourCycle: 'h23', timeZone: 'UTC' })
      .formatToParts(time)
      .map(part => [part.type, part.value])
  ) as Record<string, string>
}

/** "Sun, Oct 4, 15:02 UTC" */
export function formatStamp(iso: string | null | undefined): string {
  const p = parts(iso, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    weekday: 'short'
  })
  return p ? `${p.weekday}, ${p.month} ${p.day}, ${p.hour}:${p.minute} UTC` : ''
}

/** "Sun, Oct 4, 2026" */
export function formatDay(iso: string | null | undefined): string {
  const p = parts(iso, { day: 'numeric', month: 'short', weekday: 'short', year: 'numeric' })
  return p ? `${p.weekday}, ${p.month} ${p.day}, ${p.year}` : ''
}

/** "Mon, Oct 5, 2026, 09:14 UTC" */
export function formatFull(iso: string | null | undefined): string {
  const p = parts(iso, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    weekday: 'short',
    year: 'numeric'
  })
  return p ? `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} UTC` : ''
}

/** "Oct 4" */
export function formatShort(iso: string | null | undefined): string {
  const p = parts(iso, { day: 'numeric', month: 'short' })
  return p ? `${p.month} ${p.day}` : ''
}

/** "Oct 5, 09:14" (a history row under a "When (UTC)" heading) */
export function formatWhen(iso: string | null | undefined): string {
  const p = parts(iso, { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'short' })
  return p ? `${p.month} ${p.day}, ${p.hour}:${p.minute}` : ''
}
