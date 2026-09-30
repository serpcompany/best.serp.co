import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import type { MDXComponents } from 'mdx/types'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GuideMetadata } from '../content-query'
import { getRoute } from '../routes'
import { generateDynamicMetadata, SITE_PUBLIC_URL } from '../seo-config'

interface GuideDetailPageProps {
  guide: GuideMetadata
  guideHeader: ReactNode
  jsonLd: ReactNode
  mdxComponents: MDXComponents
  slug: string
}

export function generateGuideDetailMetadata(guide: GuideMetadata): Metadata {
  return generateDynamicMetadata({
    type: 'guide',
    name: guide.title,
    description: guide.description || `Learn about ${guide.title} in our comprehensive guide`,
    slug: guide.slug,
    publishedAt: guide.date,
    additionalKeywords: ['guide', 'tutorial', 'how-to', 'implementation']
  })
}

export function generateGuideDetailStaticParams(guides: GuideMetadata[]): Array<{ slug: string }> {
  return guides.map(guide => ({
    slug: guide.slug
  }))
}

export function GuideDetailPage({
  guide,
  guideHeader,
  jsonLd,
  mdxComponents,
  slug
}: GuideDetailPageProps) {
  const breadcrumbItems = [
    { name: 'Posts', href: getRoute('guides.list') },
    { name: guide.title, href: getRoute('guides.guide', { slug }) }
  ]

  return (
    <article className="container relative max-w-3xl py-6 lg:py-10">
      {jsonLd}
      <Breadcrumb items={breadcrumbItems} baseUrl={SITE_PUBLIC_URL} />
      {guideHeader}
      <div className="prose dark:prose-invert max-w-none">
        <ReactMarkdown components={mdxComponents as Components} remarkPlugins={[remarkGfm]}>
          {guide.content || ''}
        </ReactMarkdown>
      </div>
    </article>
  )
}
