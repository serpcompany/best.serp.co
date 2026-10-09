import type { Metadata } from 'next'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
import { getLegalContent } from '@/lib/content-loader'
import { getRoute } from '@/lib/routing/routes'

const path = getRoute('affiliateDisclosure')

export const metadata: Metadata = generateLegalPageMetadata(path)

export default async function AffiliateDisclosurePage() {
  return <LegalStaticPage content={await getLegalContent('affiliate-disclosure')} path={path} />
}
