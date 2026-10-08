import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { components } from '@/components/content/mdx-components'
import { getRoute } from '@/lib/routing/routes'
import {
  generateLegalPageMetadata,
  LegalStaticPage
} from '@/components/static-pages/legal-page'
import type { Metadata } from 'next'
import { getLegalContent } from '@/lib/content-loader'

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
