import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { components } from '@serpdirectory/web-core/mdx-components'
import { getRoute } from '@serpdirectory/web-core/routes'
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
  path: getRoute('terms')
})

export default async function TermsOfServicePage() {
  const content = await getLegalContent('terms')

  return (
    <LegalStaticPage
      content={content}
      mdxComponents={components}
      path={getRoute('terms')}
      slots={{ Breadcrumb }}
      title="Terms of Service"
    />
  )
}
