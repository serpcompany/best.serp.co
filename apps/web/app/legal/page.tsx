import { getRoute } from '@serpdirectory/web-core/routes'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'SERP Legal',
  description: 'Legal policies and terms for SERP.'
}

export default function LegalPage() {
  return (
    <main className="container mx-auto max-w-3xl px-6 py-16">
      <div className="space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">Legal</h1>
        <div className="grid gap-3">
          <Link className="font-medium text-primary" href={getRoute('privacy')}>
            Privacy Policy
          </Link>
          <Link className="font-medium text-primary" href={getRoute('terms')}>
            Terms and Conditions
          </Link>
        </div>
      </div>
    </main>
  )
}
