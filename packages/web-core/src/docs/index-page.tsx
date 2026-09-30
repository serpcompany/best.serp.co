import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import type { MDXComponents } from 'mdx/types'
import type { Metadata } from 'next'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DocMetadata } from '../content-query'
import { getRoute } from '../routes'
import { generateBaseMetadata, SITE_PUBLIC_URL } from '../seo-config'
import { siteConfig } from '../site-config'
import { siteCopy } from '../site-copy'

interface DocsIndexPageProps {
  doc: DocMetadata
  mdxComponents: MDXComponents
}

export function generateDocsIndexMetadata(): Metadata {
  return generateBaseMetadata({
    title: `${siteCopy.docsLabel} - ${siteConfig.name}`,
    description: `Reference docs, setup notes, and workflow details for ${siteConfig.name}.`,
    path: getRoute('docs.list'),
    keywords: [
      'documentation',
      'setup notes',
      'workflow reference',
      'starter docs',
      `${siteConfig.name} documentation`
    ]
  })
}

export function DocsIndexPage({ doc, mdxComponents }: DocsIndexPageProps) {
  return (
    <article>
      <Breadcrumb
        items={[{ name: siteCopy.docsLabel, href: getRoute('docs.list') }]}
        baseUrl={SITE_PUBLIC_URL}
      />
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
