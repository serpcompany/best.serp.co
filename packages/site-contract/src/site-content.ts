import { pornVideoDownloadersComSiteContent } from '../../../sites/pornvideodownloaders.com/site-content'
import { serpSoftwareSiteContent } from '../../../sites/serp.software/site-content'
import { type ActiveCheckedInSiteId, assertSiteIdIsSupported } from './active-site-ids'
import type { SiteOwnedContent } from './types'

const siteContentById = {
  'pornvideodownloaders.com': pornVideoDownloadersComSiteContent,
  'serp.software': serpSoftwareSiteContent
} satisfies Record<ActiveCheckedInSiteId, SiteOwnedContent>

export function resolveSiteContent(siteId: string): SiteOwnedContent {
  assertSiteIdIsSupported(siteId)
  return siteContentById[siteId as ActiveCheckedInSiteId]
}
