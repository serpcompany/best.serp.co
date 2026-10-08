import { Breadcrumb } from '@/components/layout/breadcrumb'
import type { Metadata } from 'next'
import { components } from '@/components/content/mdx-components'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
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
