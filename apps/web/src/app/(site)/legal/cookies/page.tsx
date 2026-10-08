import type { Metadata } from 'next'
import { components } from '@/components/content/mdx-components'
import { SiteBreadcrumb } from '@/components/layout/site-breadcrumb'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
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
      slots={{ Breadcrumb: SiteBreadcrumb }}
      title="Cookie Policy"
    />
  )
}
