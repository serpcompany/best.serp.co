/**
 * D1 rows hold two time formats: `CURRENT_TIMESTAMP` defaults (`YYYY-MM-DD HH:MM:SS`, UTC) and
 * ISO instants written by plans; Better Auth writes epoch milliseconds. All become ISO instants.
 */
export function toInstant(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  const text = String(value)
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : /^\d{4}-\d{2}-\d{2}$/u.test(text)
      ? `${text}T00:00:00Z`
      : text
  const time = Date.parse(normalized)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

/** The latest of several D1 times as an ISO instant, or null when none parses. */
export function latestInstant(...values: unknown[]): string | null {
  const instants = values.flatMap(value => {
    const instant = toInstant(value)
    return instant ? [instant] : []
  })
  return instants.length ? instants.reduce((latest, next) => (next > latest ? next : latest)) : null
}
