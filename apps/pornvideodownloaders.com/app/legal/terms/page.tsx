import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { components } from '@serpdirectory/web-core/mdx-components'
import {
  generateLegalPageMetadata,
  LegalStaticPage
} from '@serpdirectory/web-core/static-pages/legal-page'
import type { Metadata } from 'next'
import { getLegalContent } from '@/lib/content-loader'

export const metadata: Metadata = generateLegalPageMetadata({
  title: 'Terms of Service',
  description:
    'Terms of service for {{SITE_NAME}}. Read our terms and conditions for using this service.',
  path: '/legal/terms'
})

export default async function TermsOfServicePage() {
  const content = await getLegalContent('terms')

  return (
    <LegalStaticPage
      content={content}
      mdxComponents={components}
      path="/legal/terms"
      slots={{ Breadcrumb }}
      title="Terms of Service"
    />
  )
}
