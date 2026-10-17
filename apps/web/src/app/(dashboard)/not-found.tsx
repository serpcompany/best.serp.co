import type { Metadata } from 'next'
import { NotFoundContent, notFoundMetadata } from '@/components/layout/not-found-content'
import { notFoundLinkTargets } from '@/lib/catalog/site-nav'

export function generateMetadata(): Metadata {
  return notFoundMetadata()
}

/** `notFound()` in `/account` and `/admin`: the 404, with the same links, without the public chrome. */
export default async function DashboardNotFound() {
  return (
    <main className="flex min-h-screen flex-col">
      <NotFoundContent {...(await notFoundLinkTargets())} />
    </main>
  )
}
