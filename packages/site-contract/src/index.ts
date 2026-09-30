import { pornVideoDownloadersComSiteConfig } from '../../../sites/pornvideodownloaders.com/site-config'
import { serpSoftwareSiteConfig } from '../../../sites/serp.software/site-config'
import {
  type ActiveCheckedInSiteId,
  assertSiteIdIsSupported,
  resolveRuntimeSiteId
} from './active-site-ids'
import { resolveSiteContent } from './site-content'
import type { CheckedInSiteConfig } from './types'

export { resolveSiteContent }
export { resolveRuntimeSiteId }
export type { CheckedInSiteConfig } from './types'

export const siteConfigsById = {
  'pornvideodownloaders.com': pornVideoDownloadersComSiteConfig,
  'serp.software': serpSoftwareSiteConfig
} satisfies Record<ActiveCheckedInSiteId, CheckedInSiteConfig>

export function resolveCheckedInSiteConfig(siteId: string): CheckedInSiteConfig {
  assertSiteIdIsSupported(siteId)
  return siteConfigsById[siteId as ActiveCheckedInSiteId]
}
