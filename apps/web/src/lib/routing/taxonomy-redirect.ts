import 'server-only'

import { permanentRedirect } from 'next/navigation'
import type { TaxonomyKind, TaxonomyTarget } from '@/db/contracts'
import { getTaxonomyRedirect } from '@/lib/catalog/repository'
import { taxonomyTargetRoute, withoutPageQuery } from './legacy-root'

/** A page's `searchParams`, as Next.js passes them. */
export type PageSearchParams = Record<string, string | string[] | undefined>

/**
 * The query string a page was requested with, rebuilt from its decoded `searchParams` (a page sees
 * no raw URL): every value of every parameter, in order.
 */
export function searchFromParams(params: PageSearchParams): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    for (const item of [value].flat()) if (item !== undefined) search.append(name, item)
  }
  const query = search.toString()
  return query ? `?${query}` : ''
}

/**
 * The `Location` of a moved taxonomy page's 308: its target's canonical URL with the request's
 * query string, less `page` (#341 design 2.2, rule 4), as the Worker's root-level redirect writes
 * it (`legacyRootLocation`).
 */
export function movedTaxonomyLocation(target: TaxonomyTarget, params: PageSearchParams): string {
  return `${taxonomyTargetRoute(target)}${withoutPageQuery(searchFromParams(params))}`
}

/**
 * For a hub, tag or best page that has nothing to show (#341 design 2.2, rule 1): one 308 to
 * where `taxonomy_redirects` moved its URL. Returns when it moved nowhere, and the page answers
 * 404. Rendering wins over the redirect, so ask only after the page missed.
 */
export async function redirectMovedTaxonomyPage(
  kind: TaxonomyKind,
  slug: string,
  params: PageSearchParams
): Promise<void> {
  const target = await getTaxonomyRedirect(kind, slug)
  if (target) permanentRedirect(movedTaxonomyLocation(target, params))
}
