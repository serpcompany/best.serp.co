import 'server-only'

import { listedBestPages } from '@/lib/seo/taxonomy-indexing'
import { getBestPages } from './repository'

/**
 * Whether the header links the best-page index (#347): only while it lists a best page, the test
 * that also makes `/best/` indexable, so the nav never links an index that shows only its heading.
 * It reads the cached best index (per epoch, shared with the pages that list best pages), so it
 * adds no statement of its own. A failed read hides the link instead of failing the page.
 */
export async function linksBestIndex(): Promise<boolean> {
  try {
    return listedBestPages(await getBestPages()).length > 0
  } catch {
    return false
  }
}
