import { Mail } from 'lucide-react'
import type { Metadata } from 'next'
import { CardGrid } from '@/components/layout/card-grid'
import { ListCard } from '@/components/layout/list-card'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { siteConfig } from '@/lib/site/site-config'

export const metadata: Metadata = generateBaseMetadata({
  title: `Contact ${siteConfig.name}`,
  description:
    'Contact the SERP team for listing, partnership, and support questions about the SERP directory of products and resources.',
  path: '/contact/'
})

/** serplists' Contact (#275): a centered hero, then the address as a card. */
export default function ContactPage() {
  return (
    <>
      <PageSection spacing="hero">
        <PageHero
          align="center"
          title="Contact SERP"
          description="Contact the SERP team for listing, partnership, and support questions."
        />
      </PageSection>
      <PageSection className="pt-0" spacing="spacious" width="narrow">
        <CardGrid columns={1}>
          <ListCard href="mailto:hello@serp.co" icon={<Mail />} title="hello@serp.co" />
        </CardGrid>
      </PageSection>
    </>
  )
}
