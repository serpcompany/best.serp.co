import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import { components } from '@serpdirectory/web-core/mdx-components'
import {
  generateLegalPageMetadata,
  LegalStaticPage
} from '@serpdirectory/web-core/static-pages/legal-page'
import type { Metadata } from 'next'
import { getLegalContent } from '@/lib/content-loader'

export const metadata: Metadata = generateLegalPageMetadata({
  title: 'Cookie Policy',
  description:
    'Cookie policy for {{SITE_NAME}}. Learn how we use cookies and similar technologies.',
  path: '/legal/cookies'
})

export default async function CookiePolicyPage() {
  const content = await getLegalContent('cookies')

  return (
    <LegalStaticPage
      content={content}
      mdxComponents={components}
      path="/legal/cookies"
      slots={{ Breadcrumb }}
      title="Cookie Policy"
    />
  )
}
