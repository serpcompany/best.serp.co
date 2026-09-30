import { DocsIndexPage, generateDocsIndexMetadata } from '@serpdirectory/web-core/docs/index-page'
import { components } from '@serpdirectory/web-core/mdx-components'
import type { Metadata as NextMetadata } from 'next'
import { notFound } from 'next/navigation'
import { getDocBySlug } from '@/lib/content-loader'
import {
  generateDisabledRouteMetadata,
  isRouteFeatureEnabled,
  requireRouteFeature
} from '@/lib/route-feature-gates'

export function generateMetadata(): NextMetadata {
  if (!isRouteFeatureEnabled('showDocs')) {
    return generateDisabledRouteMetadata()
  }

  return generateDocsIndexMetadata()
}

export default async function DocsPage() {
  requireRouteFeature('showDocs')

  const doc = await getDocBySlug('getting-started')

  if (!doc) {
    notFound()
  }

  return <DocsIndexPage doc={doc} mdxComponents={components} />
}
