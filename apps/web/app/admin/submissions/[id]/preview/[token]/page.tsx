import { ProjectNavigation } from '@serpdirectory/web-core/project-navigation'
import { ExternalResourcesSectionRoute as ExternalResourcesSection } from '@serpdirectory/web-core/sections/external-resources-section-route'
import { WebsiteContentSectionRoute as WebsiteContentSection } from '@serpdirectory/web-core/website/website-content-section-route'
import { WebsiteDetailSidebar } from '@serpdirectory/web-core/website/website-detail-sidebar'
import {
  WebsiteHeroRoute as WebsiteHero,
  type WebsiteHeroRouteProps
} from '@serpdirectory/web-core/website/website-hero-route'
import { WebsiteRelatedProjectsRoute as WebsiteRelatedProjects } from '@serpdirectory/web-core/website/website-related-projects-route'
import { WebsiteResourcesSectionRoute as WebsiteResourcesSection } from '@serpdirectory/web-core/website/website-resources-section-route'
import { WebsiteDetailRoutePage } from '@serpdirectory/web-core/website-routes/detail-page'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { reviewPreviewAccessSchema } from '@/lib/submissions/review-preview'
import { getSubmissionReviewPreview } from '@/lib/submissions/review-preview-repository'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Private submission draft preview',
  description: 'Private reviewer preview of an unpublished directory submission.',
  referrer: 'no-referrer',
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nocache: true,
    nosnippet: true
  }
}

interface ReviewPreviewPageProps {
  params: Promise<{ id: string; token: string }>
}

function PrivatePreviewJsonLd(): null {
  return null
}

function PrivatePreviewWebsiteHero(props: WebsiteHeroRouteProps) {
  return <WebsiteHero {...props} structuredData={false} />
}

export default async function ReviewPreviewPage({ params }: ReviewPreviewPageProps) {
  const access = reviewPreviewAccessSchema.safeParse(await params)
  if (!access.success) notFound()

  const project = await getSubmissionReviewPreview(access.data)
  if (!project) notFound()

  return (
    <>
      <aside
        className="border-b border-amber-300/60 bg-amber-50 px-6 py-3 text-amber-950 dark:border-amber-700/60 dark:bg-amber-950 dark:text-amber-50"
        aria-label="Draft preview status"
      >
        <div className="container mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <strong>Private draft preview</strong>
          <span className="text-sm">Unpublished — admin review only</span>
        </div>
      </aside>
      <WebsiteDetailRoutePage
        project={project}
        slots={{
          ExternalResourcesSection,
          JsonLd: PrivatePreviewJsonLd,
          ProjectNavigation,
          WebsiteContentSection,
          WebsiteDetailSidebar,
          WebsiteHero: PrivatePreviewWebsiteHero,
          WebsiteRelatedProjects,
          WebsiteResourcesSection
        }}
      />
    </>
  )
}
