import { Mail } from 'lucide-react'
import type { Metadata } from 'next'
import { CardGrid } from '@/components/layout/card-grid'
import { ListCard } from '@/components/layout/list-card'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: 'Sponsor SERP',
    description:
      'Sponsorship options for reaching the SERP audience: people researching software, AI tools, resources, and SERP network projects.',
    path: '/sponsor/'
  })
}

/** Laid out as serplists' Contact (#275): a centered hero, then the address as a card. */
export default function SponsorPage() {
  return (
    <>
      <PageSection spacing="hero">
        <PageHero
          align="center"
          title="Sponsor SERP"
          description="Reach people researching software, AI tools, resources, and SERP network projects."
        />
      </PageSection>
      <PageSection className="pt-0" spacing="spacious" width="narrow">
        <CardGrid columns={1}>
          <ListCard href="mailto:sponsor@serp.co" icon={<Mail />} title="sponsor@serp.co" />
        </CardGrid>
      </PageSection>
    </>
  )
}
