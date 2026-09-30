import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import type { GuideMetadata } from '../content-query'
import { getRoute } from '../routes'
import { generateBaseMetadata } from '../seo-config'
import { siteConfig } from '../site-config'

interface GuidesIndexPageProps {
  breadcrumb: ReactNode
  emptyState: ReactNode
  guideCard: (guide: GuideMetadata, index: number) => ReactNode
  guides: GuideMetadata[]
  jsonLd: ReactNode
}

export function generateGuidesIndexMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Posts',
    description: `Browse posts, walkthroughs, and reference notes for ${siteConfig.name}.`,
    path: getRoute('guides.list'),
    keywords: [
      'directory posts',
      'product walkthroughs',
      'reference notes',
      'blog posts',
      `${siteConfig.name} posts`
    ]
  })
}

export function GuidesIndexPage({
  breadcrumb,
  emptyState,
  guideCard,
  guides,
  jsonLd,
}: GuidesIndexPageProps) {
  return (
    <div className="container mx-auto py-8">
      {jsonLd}
      <div className="space-y-12">
        {breadcrumb}

        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight flex items-center gap-3">
            <span className="size-2 bg-primary rounded-full" />
            Posts
          </h1>
          <p className="text-lg text-muted-foreground">
            Browse posts, walkthroughs, and reference notes for this directory.
          </p>
        </div>

        {guides?.length ? (
          <section className="space-y-6">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
              All Posts ({guides.length})
            </h2>
            <div className="grid gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {guides.map((guide, index) => guideCard(guide, index))}
            </div>
          </section>
        ) : (
          emptyState
        )}
      </div>
    </div>
  )
}
