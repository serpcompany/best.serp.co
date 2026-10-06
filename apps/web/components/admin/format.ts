/**
 * Formatting for the admin screens (#64), in UTC like every time the panel shows: ages in the
 * queue ("5 h", "3 d"), days ("Tue, Oct 6"), times ("Tue, Oct 6, 10:42"), and money.
 */

/** The paid plan's price (#59). The amount actually charged is in #68's orders. */
export const PAID_LISTING_PRICE_CENTS = 4900

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How long ago, in whole hours under a day and whole days after that. */
export function ageLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—'
  const elapsed = Math.max(0, now.getTime() - Date.parse(iso))
  if (elapsed < HOUR) return '<1 h'
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`
  return `${Math.floor(elapsed / DAY)} d`
}

/** "3 days", "5 hours": the queue subtitle's "oldest" phrase. */
export function ageWords(iso: string | null, now: Date = new Date()): string {
  if (!iso) return ''
  const elapsed = Math.max(0, now.getTime() - Date.parse(iso))
  if (elapsed < HOUR) return 'under an hour'
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  const days = Math.floor(elapsed / DAY)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

function parts(iso: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: 'short',
      timeZone: 'UTC',
      weekday: 'short',
      year: 'numeric'
    })
      .formatToParts(new Date(iso))
      .map(part => [part.type, part.value])
  )
}

/** "Tue, Oct 6" */
export function formatDay(iso: string | null): string {
  if (!iso) return '—'
  const p = parts(iso)
  return `${p.weekday}, ${p.month} ${p.day}`
}

/** "Tue, Oct 6, 10:42" (UTC) */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const p = parts(iso)
  return `${p.weekday}, ${p.month} ${p.day}, ${p.hour}:${p.minute}`
}

/** "Oct 1" */
export function formatShortDate(iso: string | null): string {
  if (!iso) return '—'
  const p = parts(iso)
  return `${p.month} ${p.day}`
}

/** "May 16, 2026" */
export function formatLongDate(iso: string | null): string {
  if (!iso) return '—'
  const p = parts(iso)
  return `${p.month} ${p.day}, ${p.year}`
}

/** "Oct 6, 2026" for "Since …" lines. */
export const formatSince = formatLongDate

/** Two letters for an avatar: from the name, else from the address. */
export function initials(email: string, name?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/u).filter(Boolean)
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words.at(-1)?.[0] ?? ''}`.toUpperCase()
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return email.slice(0, 2).toUpperCase()
}

/** The public URL path of a listing. */
export function listingPath(slug: string): string {
  return `/products/${slug}/`
}
