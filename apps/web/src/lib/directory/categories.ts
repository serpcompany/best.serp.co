import type { LucideIcon } from 'lucide-react'
import { Code2, Database, Download, Package } from 'lucide-react'

/**
 * The hubs' icons (#341, design 6 step 9): D1 owns every category's name and description, so
 * only icons are checked in. A hub without one here shows `Package`.
 */
const hubIcons: ReadonlyMap<string, LucideIcon> = new Map([
  ['data-analytics', Database],
  ['developer-tools', Code2],
  ['video-downloaders', Download]
])

export function getCategoryIcon(slug: string): LucideIcon {
  return hubIcons.get(slug) ?? Package
}

/** Category names from D1 by slug (the shell stats' active categories, #416). */
export function categoryNamesBySlug(
  categories: ReadonlyArray<{ name: string; slug: string }>
): Map<string, string> {
  return new Map(categories.map(category => [category.slug, category.name]))
}

/**
 * A category's name: D1's (`names`, `categoryNamesBySlug`), else cased from its slug, the last
 * resort for a slug D1 doesn't name, such as a retired category's (#416).
 */
export function categoryName(slug: string, names: ReadonlyMap<string, string>): string {
  return names.get(slug) ?? categoryNameFromSlug(slug)
}

/**
 * A category's name cased from its slug (`video-downloaders` is "Video Downloaders"): only for a
 * slug D1 doesn't name. Where D1's names are at hand, use `categoryName` (#416).
 */
export function categoryNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map(word => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
}
