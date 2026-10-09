import type { Metadata } from 'next'
import { generateLegalPageMetadata, LegalStaticPage } from '@/components/static-pages/legal-page'
import { getLegalContent } from '@/lib/content-loader'
import { getRoute } from '@/lib/routing/routes'

const path = getRoute('cookies')

export const metadata: Metadata = generateLegalPageMetadata(path)

export default async function CookiePolicyPage() {
  return <LegalStaticPage content={await getLegalContent('cookies')} path={path} />
}
