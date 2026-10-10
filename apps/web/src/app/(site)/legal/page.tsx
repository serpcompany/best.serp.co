import { Cookie, Copyright, Handshake, ScrollText, ShieldCheck } from 'lucide-react'
import type { Metadata } from 'next'
import { CardGrid } from '@/components/layout/card-grid'
import { PageShell } from '@/components/layout/docs-page-shell'
import { ListCard } from '@/components/layout/list-card'
import { LegalNav, legalDescription } from '@/components/legal/legal-nav'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata, SITE_NAME } from '@/lib/seo/seo-config'
import { legalPages } from '@/lib/site/legal-pages'

const description =
  'Legal policies and terms for SERP: the privacy policy and the terms and conditions that apply to using the SERP directory.'

export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'SERP Legal',
    description,
    path: '/legal/'
  })
}

/** serp.co's page icons (`components/icons.ts`), with a cookie for the cookie policy. */
const icons = {
  [getRoute('privacy')]: ShieldCheck,
  [getRoute('terms')]: ScrollText,
  [getRoute('cookies')]: Cookie,
  [getRoute('affiliateDisclosure')]: Handshake,
  [getRoute('dmca')]: Copyright
}

/** serp.co's legal index (#276): the legal nav beside a card for each policy. */
export default function LegalPage() {
  return (
    <PageShell
      title="Legal"
      eyebrow={SITE_NAME}
      description={<p>{description}</p>}
      layout="sidebar"
      aside={<LegalNav current="/legal/" />}
    >
      <CardGrid as="ul" columns={2}>
        {legalPages.map(page => {
          const Icon = icons[page.path]
          return (
            <li key={page.path} className="min-w-0">
              <ListCard
                className="h-full"
                description={legalDescription(page.description)}
                href={page.path}
                icon={<Icon />}
                title={page.title}
                titleAs="h2"
              />
            </li>
          )
        })}
      </CardGrid>
    </PageShell>
  )
}
