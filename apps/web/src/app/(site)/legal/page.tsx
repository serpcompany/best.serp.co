import type { Metadata } from 'next'
import Link from 'next/link'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'

export const metadata: Metadata = generateBaseMetadata({
  title: 'SERP Legal',
  description:
    'Legal policies and terms for SERP: the privacy policy and the terms and conditions that apply to using the SERP directory.',
  path: '/legal/'
})

export default function LegalPage() {
  return (
    <div className="container mx-auto max-w-3xl px-6 py-16">
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
    </div>
  )
}
