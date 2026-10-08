import { Breadcrumb } from '@/components/layout/breadcrumb'
import type { Metadata } from 'next'
import { components } from '@/components/content/mdx-components'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
import { getLegalContent } from '@/lib/content-loader'
import { getRoute } from '@/lib/routing/routes'

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
