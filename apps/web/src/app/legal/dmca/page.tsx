import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { components } from '@serpdirectory/web-core/mdx-components'
import {
  generateLegalPageMetadata,
  LegalStaticPage
} from '@serpdirectory/web-core/static-pages/legal-page'
import type { Metadata } from 'next'
import { getLegalContent } from '@/lib/content-loader'

export const metadata: Metadata = generateLegalPageMetadata({
  title: 'DMCA',
  description:
    'DMCA policy for {{SITE_NAME}}. Learn how to submit copyright and intellectual property complaints.',
  path: '/legal/dmca'
})

export default async function DmcaPage() {
  const content = await getLegalContent('dmca')

  return (
    <LegalStaticPage
      content={content}
      mdxComponents={components}
      path="/legal/dmca"
      slots={{ Breadcrumb }}
      title="DMCA"
    />
  )
}
