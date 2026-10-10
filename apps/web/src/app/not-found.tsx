import type { Metadata } from 'next'
import { NotFoundContent, notFoundMetadata } from '@/components/layout/not-found-content'
import { SiteChrome } from '@/components/layout/site-chrome'

export function generateMetadata(): Metadata {
  return notFoundMetadata()
}

/** Unknown URLs and `notFound()` on the public site: the 404 in the public chrome. */
export default function NotFound() {
  return (
    <SiteChrome>
      <NotFoundContent />
    </SiteChrome>
  )
}
