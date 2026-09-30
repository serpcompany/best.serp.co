import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Sponsor SERP',
  description: 'Sponsorship options for reaching the SERP audience.'
}

export default function SponsorPage() {
  return (
    <main className="container mx-auto max-w-3xl px-6 py-16">
      <div className="space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">Sponsor SERP</h1>
        <p className="text-lg text-muted-foreground">
          Reach people researching software, AI tools, resources, and SERP network projects.
        </p>
        <a
          className="inline-flex font-medium text-primary underline-offset-4 hover:underline"
          href="mailto:sponsor@serp.co"
        >
          sponsor@serp.co
        </a>
      </div>
    </main>
  )
}
