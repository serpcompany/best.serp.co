import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import type { MDXComponents } from 'mdx/types'
import type { Metadata } from 'next'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocMetadata } from '../content-query'
import { getRoute } from '../routes'
import { generateDynamicMetadata, SITE_PUBLIC_URL } from '../seo-config'
import { siteCopy } from '../site-copy'

interface DocDetailPageProps {
  doc: DocMetadata
  mdxComponents: MDXComponents
  slug: string
}

export function generateDocDetailMetadata(doc: DocMetadata): Metadata {
  return generateDynamicMetadata({
    type: 'doc',
    name: doc.title,
    description: doc.description,
    slug: doc.slug,
    additionalKeywords: ['documentation', 'reference', 'workflow notes']
  })
}

export function generateDocDetailStaticParams(docs: DocMetadata[]): Array<{ slug: string }> {
  return docs
    .filter(doc => doc.slug !== 'getting-started')
    .map(doc => ({
      slug: doc.slug
    }))
}

export function DocDetailPage({ doc, mdxComponents, slug }: DocDetailPageProps) {
  const breadcrumbItems = [
    { name: siteCopy.docsLabel, href: getRoute('docs.list') },
    { name: doc.title, href: getRoute('docs.doc', { slug }) }
  ]

  return (
    <article>
      <Breadcrumb items={breadcrumbItems} baseUrl={SITE_PUBLIC_URL} />
      <div className="space-y-2 mt-6 mb-8">
        <h1 className="text-4xl font-bold tracking-tight">{doc.title}</h1>
        <p className="text-lg text-muted-foreground">{doc.description}</p>
      </div>
      <div className="prose dark:prose-invert max-w-none">
        <ReactMarkdown components={mdxComponents as Components} remarkPlugins={[remarkGfm]}>
          {doc.content || ''}
        </ReactMarkdown>
      </div>
    </article>
  )
}
