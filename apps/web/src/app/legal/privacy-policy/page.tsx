import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import type { Metadata } from 'next'
import { components } from '@/components/content/mdx-components'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
import { getLegalContent } from '@/lib/content-loader'
import { getRoute } from '@/lib/routing/routes'

export const metadata: Metadata = generateLegalPageMetadata({
  title: 'Privacy Policy',
  description:
    'Privacy policy for {{SITE_NAME}}. Learn how we collect, use, and protect your information.',
  path: getRoute('privacy')
})

export default async function PrivacyPolicyPage() {
  const content = await getLegalContent('privacy')

  return (
    <LegalStaticPage
      content={content}
      mdxComponents={components}
      path={getRoute('privacy')}
      slots={{ Breadcrumb }}
      title="Privacy Policy"
    />
  )
}
