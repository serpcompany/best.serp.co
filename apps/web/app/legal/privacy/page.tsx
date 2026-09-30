import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { components } from '@serpdirectory/web-core/mdx-components'
import {
  generateLegalPageMetadata,
  LegalStaticPage
} from '@serpdirectory/web-core/static-pages/legal-page'
import type { Metadata } from 'next'
import { getLegalContent } from '@/lib/content-loader'

export const metadata: Metadata = generateLegalPageMetadata({
  title: 'Privacy Policy',
  description:
    'Privacy policy for {{SITE_NAME}}. Learn how we collect, use, and protect your information.',
  path: '/legal/privacy'
})

export default async function PrivacyPolicyPage() {
  const content = await getLegalContent('privacy')

  return (
    <LegalStaticPage
      content={content}
      mdxComponents={components}
      path="/legal/privacy"
      slots={{ Breadcrumb }}
      title="Privacy Policy"
    />
  )
}
