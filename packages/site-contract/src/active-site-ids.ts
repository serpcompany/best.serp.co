export const activeCheckedInSiteIds = ['pornvideodownloaders.com', 'serp.software'] as const
export type ActiveCheckedInSiteId = (typeof activeCheckedInSiteIds)[number]
const activeCheckedInSiteIdSet = new Set<string>(activeCheckedInSiteIds)

export const removedSiteIds = new Set([
  'extensions.serp.co',
  'browserextensions.io',
  'serp.ai',
  'serp.co',
  'serpdownloaders.com'
])

export function assertSiteIdIsNotRemoved(siteId: string): void {
  if (!removedSiteIds.has(siteId)) {
    return
  }

  throw new Error(
    `Site "${siteId}" was removed from this repo. Use a supported checked-in site id instead.`
  )
}

export function assertSiteIdIsSupported(siteId: string): void {
  assertSiteIdIsNotRemoved(siteId)

  if (activeCheckedInSiteIdSet.has(siteId)) {
    return
  }

  throw new Error(
    `Site "${siteId}" is not active in this repo. Use one of: ${activeCheckedInSiteIds.join(', ')}.`
  )
}

export function resolveRuntimeSiteId(
  env: { NEXT_PUBLIC_SITE_ID?: string; SITE_ID?: string } = {
    NEXT_PUBLIC_SITE_ID: process.env.NEXT_PUBLIC_SITE_ID,
    SITE_ID: process.env.SITE_ID
  }
): ActiveCheckedInSiteId {
  const publicSiteId = env.NEXT_PUBLIC_SITE_ID
  const serverSiteId = env.SITE_ID
  if (publicSiteId && serverSiteId && publicSiteId !== serverSiteId) {
    throw new Error(
      `NEXT_PUBLIC_SITE_ID "${publicSiteId}" does not match SITE_ID "${serverSiteId}".`
    )
  }
  const siteId = publicSiteId || serverSiteId
  if (!siteId) {
    throw new Error('SITE_ID or NEXT_PUBLIC_SITE_ID is required; site selection has no default.')
  }
  assertSiteIdIsSupported(siteId)
  return siteId as ActiveCheckedInSiteId
}
