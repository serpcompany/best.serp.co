import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CardGrid } from '@/components/layout/card-grid'
import { PageHero } from '@/components/layout/page-hero'
import { PageSection } from '@/components/layout/page-shell'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { siteConfig } from '@/lib/site/site-config'

export function generateMetadata(): Metadata {
  return generateBaseMetadata({
    title: `${siteConfig.name} Pricing`,
    description:
      'Choose a plan to list, feature, and promote a product or resource on SERP: submit a directory listing for review, or sponsor SERP to reach its audience.',
    path: '/pricing/'
  })
}

/** A plan: serplists' pricing `PlanCard` (#275), without a feature list. */
function PlanCard({
  action,
  description,
  title
}: {
  action: ReactNode
  description: ReactNode
  title: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter className="mt-auto">{action}</CardFooter>
    </Card>
  )
}

/** serplists' Pricing (#275): a centered hero, then the plans side by side. */
export default function PricingPage() {
  return (
    <>
      <PageSection spacing="hero">
        <PageHero
          align="center"
          title="SERP Pricing"
          description="Choose a plan to list, feature, and promote a product or resource on SERP."
        />
      </PageSection>
      <PageSection className="pt-0" spacing="spacious" width="narrow">
        <CardGrid columns={2}>
          <PlanCard
            title="Directory listing"
            description="Submit a product or resource for review by the SERP team."
            action={
              <Link href={getRoute('submit')} className={buttonVariants()}>
                Submit a listing
              </Link>
            }
          />
          <PlanCard
            title="Sponsorship"
            description="Promote a relevant product to the SERP audience."
            action={
              <Link href="/sponsor/" className={buttonVariants({ variant: 'outline' })}>
                Sponsor SERP
              </Link>
            }
          />
        </CardGrid>
      </PageSection>
    </>
  )
}
