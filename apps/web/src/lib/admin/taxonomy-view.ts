import type { AdminBestPageRow, AdminCategory, AdminTag } from '@/db/admin-queries'

/**
 * What the taxonomy screens (#405) derive from the reads: the count line, the redirect choices a
 * retirement offers (every other active category, tag, and best page), and a create form's
 * values prefilled from the URL (`?name=…`), so another screen can open it filled in.
 */

/** "1 tag", "125 tags". */
export function countLabel(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/**
 * The pages a retirement may redirect to: every other active category, tag, and best page whose
 * page renders now, since a redirect is followed only to a page that renders (#346), plus the
 * directory (the dialog's own first choice).
 */
export function redirectChoices(
  input: {
    bestPages: readonly AdminBestPageRow[]
    categories: readonly AdminCategory[]
    tags: readonly AdminTag[]
  },
  self: { kind: 'best' | 'category' | 'tag'; slug: string }
) {
  const other = (kind: string, slug: string) => kind !== self.kind || slug !== self.slug
  return {
    bestPages: input.bestPages
      .filter(page => page.renders && other('best', page.slug))
      .map(page => ({ label: page.title, value: `best:${page.slug}` })),
    categories: input.categories
      .filter(category => category.renders && other('category', category.slug))
      .map(category => ({ label: category.name, value: `category:${category.slug}` })),
    tags: input.tags
      .filter(tag => tag.renders && other('tag', tag.slug))
      .map(tag => ({ label: `${tag.name} (${tag.categoryName})`, value: `tag:${tag.slug}` }))
  }
}

/** The first of `candidates` the choices offer, or the directory. */
export function defaultRedirect(
  choices: ReturnType<typeof redirectChoices>,
  candidates: ReadonlyArray<string | null>
): string {
  const offered = new Set(
    [...choices.bestPages, ...choices.categories, ...choices.tags].map(choice => choice.value)
  )
  return candidates.find(value => value !== null && offered.has(value)) ?? 'directory'
}

/** The named search parameters that are strings, for a create form's initial values. */
export function prefill<K extends string>(
  params: Record<string, string | string[] | undefined>,
  keys: readonly K[]
): Partial<Record<K, string>> {
  return Object.fromEntries(
    keys.flatMap(key => {
      const value = params[key]
      return typeof value === 'string' && value ? [[key, value.slice(0, 2_000)]] : []
    })
  ) as Partial<Record<K, string>>
}

/** Open category suggestions grouped by name (#406), so repeats show as one row. */
export interface SuggestionGroup {
  /** How many open submissions and revisions suggest it. */
  count: number
  key: string
  /** The spelling it was first suggested with. */
  name: string
  records: Array<{
    categoryName: string | null
    href: string
    listingName: string
    note: string | null
  }>
}

/** Groups suggestions by their name, ignoring case and spacing, most suggested first. */
export function groupSuggestions(
  rows: ReadonlyArray<{
    categoryName: string | null
    id: string
    kind: 'revision' | 'submission'
    listingName: string
    name: string
    note: string | null
  }>
): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>()
  for (const row of rows) {
    const key = row.name.trim().replace(/\s+/gu, ' ').toLowerCase()
    const group = groups.get(key) ?? { count: 0, key, name: row.name.trim(), records: [] }
    group.count += 1
    group.records.push({
      categoryName: row.categoryName,
      href: `/admin/${row.kind === 'revision' ? 'revisions' : 'submissions'}/${encodeURIComponent(row.id)}/`,
      listingName: row.listingName,
      note: row.note
    })
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'en'))
}
