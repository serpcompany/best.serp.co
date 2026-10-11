import type { AdminBestPageRow, CategoryOption, TagOption } from '@/db/admin-queries'

/**
 * What the taxonomy screens (#405) derive from the reads: the count line, the redirect choices a
 * retirement offers (every other active category, tag, and best page), and a create form's
 * values prefilled from the URL (`?name=…`), so another screen can open it filled in.
 */

/** "1 tag", "125 tags". */
export function countLabel(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

export function redirectChoices(
  input: {
    bestPages: readonly AdminBestPageRow[]
    categories: readonly CategoryOption[]
    tags: readonly TagOption[]
  },
  self: { kind: 'best' | 'category' | 'tag'; slug: string }
) {
  const other = (kind: string, slug: string) => kind !== self.kind || slug !== self.slug
  return {
    bestPages: input.bestPages
      .filter(page => other('best', page.slug))
      .map(page => ({ label: page.title, value: `best:${page.slug}` })),
    categories: input.categories
      .filter(category => other('category', category.slug))
      .map(category => ({ label: category.name, value: `category:${category.slug}` })),
    tags: input.tags
      .filter(tag => other('tag', tag.slug))
      .map(tag => ({ label: `${tag.name} (${tag.categoryName})`, value: `tag:${tag.slug}` }))
  }
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
