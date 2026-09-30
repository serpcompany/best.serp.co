import {
  resolveSiteContent as resolveCheckedInSiteContent,
  resolveRuntimeSiteId
} from '@serpdirectory/site-contract'
import type { SiteOwnedContent } from '@serpdirectory/site-contract/types'

export function resolveSiteContent(siteId = resolveRuntimeSiteId()): SiteOwnedContent {
  return resolveCheckedInSiteContent(siteId)
}

export const siteContent: SiteOwnedContent = resolveSiteContent()
