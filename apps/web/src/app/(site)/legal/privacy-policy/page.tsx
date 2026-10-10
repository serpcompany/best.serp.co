import type { Metadata } from 'next'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
import { getLegalContent } from '@/lib/content-loader'
import { getRoute } from '@/lib/routing/routes'
import { legalPageFor } from '@/lib/site/legal-pages'

const path = getRoute('privacy')

export function generateMetadata(): Metadata {
  return generateLegalPageMetadata(path)
}

export default async function PrivacyPolicyPage() {
  return (
    <LegalStaticPage content={await getLegalContent(legalPageFor(path).contentKey)} path={path} />
  )
}
