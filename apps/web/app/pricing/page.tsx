import { getRoute } from '@serpdirectory/web-core/routes'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: `${siteConfig.name} Pricing`,
  description: 'Choose a plan to list, feature, and promote a product or resource on SERP.'
}

export default function PricingPage() {
  return (
    <main className="container mx-auto max-w-4xl px-6 py-16">
      <div className="space-y-8">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight">SERP Pricing</h1>
          <p className="text-lg text-muted-foreground">
            Choose a plan to list, feature, and promote a product or resource on SERP.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <section className="rounded-lg border p-6">
            <h2 className="text-xl font-semibold">Directory listing</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Submit Yours or resource for review by the SERP team.
            </p>
            <Link className="mt-4 inline-flex font-medium text-primary" href={getRoute('submit')}>
              Submit a listing
            </Link>
          </section>
          <section className="rounded-lg border p-6">
            <h2 className="text-xl font-semibold">Sponsorship</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Promote a relevant product to the SERP audience.
            </p>
            <Link className="mt-4 inline-flex font-medium text-primary" href="/sponsor/">
              Sponsor SERP
            </Link>
          </section>
        </div>
      </div>
    </main>
  )
}
