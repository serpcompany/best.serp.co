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

/**
 * A category's name cased from its slug (`video-downloaders` is "Video Downloaders"), for a
 * page that has only the slug: D1's name (the shell stats) is the one to show where it's at hand.
 */
export function categoryNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map(word => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
}
