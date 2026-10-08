import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { siteConfig } from '@/lib/site/site-config'
import type { Metadata } from 'next'

export const metadata: Metadata = generateBaseMetadata({
  title: `Contact ${siteConfig.name}`,
  description:
    'Contact the SERP team for listing, partnership, and support questions about the SERP directory of products and resources.',
  path: '/contact/'
})

export default function ContactPage() {
  return (
    <main className="container mx-auto max-w-3xl px-6 py-16">
      <div className="space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">Contact SERP</h1>
        <p className="text-lg text-muted-foreground">
          Contact the SERP team for listing, partnership, and support questions.
        </p>
        <a
          className="inline-flex font-medium text-primary underline-offset-4 hover:underline"
          href="mailto:hello@serp.co"
        >
          hello@serp.co
        </a>
      </div>
    </main>
  )
}
