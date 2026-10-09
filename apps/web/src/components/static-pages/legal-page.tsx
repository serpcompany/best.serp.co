import type { Metadata } from 'next'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PageShell } from '@/components/layout/docs-page-shell'
import { BreadcrumbJsonLd } from '@/components/layout/site-breadcrumb'
import { legalDescription, legalShell } from '@/components/legal/legal-nav'
import { type LegalPagePath, legalPageFor } from '@/lib/legal/legal-pages'
import { generateBaseMetadata, SITE_PUBLIC_URL } from '@/lib/seo/seo-config'

/** The legal Markdown's own `# Title` is the page's h1 already; `.prose-docs` styles the rest. */
const legalMarkdownComponents: Components = { h1: () => null }

export function generateLegalPageMetadata(path: LegalPagePath): Metadata {
  const page = legalPageFor(path)
  return generateBaseMetadata({
    title: page.title,
    description: legalDescription(page.description),
    path,
    // The route registry lists every legal page as noindex too; a new one stays noindex
    // until it is registered.
    noindex: true
  })
}

/**
 * A legal page on serp.co's docs layout (#276): the breadcrumb, title and description over the
 * legal nav and the policy. The visible breadcrumb writes no JSON-LD, so the page writes the
 * `BreadcrumbList` itself.
 */
export function LegalStaticPage({ content, path }: { content: string; path: LegalPagePath }) {
  const shell = legalShell(path)
  return (
    <>
      <BreadcrumbJsonLd
        items={shell.breadcrumbs.slice(1).map(crumb => ({ name: crumb.name, href: crumb.path }))}
        baseUrl={SITE_PUBLIC_URL}
      />
      <PageShell {...shell}>
        <ReactMarkdown components={legalMarkdownComponents} remarkPlugins={[remarkGfm]}>
          {content}
        </ReactMarkdown>
      </PageShell>
    </>
  )
}
