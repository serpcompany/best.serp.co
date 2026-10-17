import type { Metadata } from 'next'
import { NotFoundContent, notFoundMetadata } from '@/components/layout/not-found-content'
import { SiteChrome } from '@/components/layout/site-chrome'
import { notFoundLinkTargets } from '@/lib/catalog/site-nav'

export function generateMetadata(): Metadata {
  return notFoundMetadata()
}

/** Unknown URLs and `notFound()` on the public site: the 404 in the public chrome. */
export default async function NotFound() {
  return (
    <SiteChrome>
      <NotFoundContent {...(await notFoundLinkTargets())} />
    </SiteChrome>
  )
}
