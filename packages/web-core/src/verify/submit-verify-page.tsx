'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { siteConfig } from '../site-config'
import { getFeaturedOnBadgeListingUrl } from '../website/featured-on-badge-url'
import { BadgePreview } from './badge-preview'
import { CopySnippet } from './copy-snippet'
import { VerifyButton } from './verify-button'

type Theme = 'light' | 'dark'

type SubmissionInfo = {
  name: string
  slug: string
  website: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; data: SubmissionInfo }

type SubmitVerifyPageRouteProps = {
  submissionEndpoint: string
  verifyEndpoint: string
}

export function SubmitVerifyPageRoute({
  submissionEndpoint,
  verifyEndpoint
}: SubmitVerifyPageRouteProps) {
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' })
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    if (!token) {
      setLoadState({ status: 'not-found' })
      return
    }

    fetch(`${submissionEndpoint}?token=${encodeURIComponent(token)}`)
      .then(async response => {
        if (response.status === 404) {
          setLoadState({ status: 'not-found' })
          return
        }

        if (!response.ok) {
          setLoadState({ status: 'error' })
          return
        }

        const data = (await response.json()) as SubmissionInfo
        setLoadState({ status: 'ready', data })
      })
      .catch(() => setLoadState({ status: 'error' }))
  }, [submissionEndpoint, token])

  if (loadState.status === 'loading') {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (loadState.status === 'not-found') {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="mb-2 text-2xl font-bold">Submission not found</h1>
        <p className="text-muted-foreground">The token in your URL is invalid or expired.</p>
        <Link href="/submit" className="mt-4 inline-block text-sm text-primary underline">
          Start a new submission
        </Link>
      </div>
    )
  }

  if (loadState.status === 'error') {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="mb-2 text-2xl font-bold">Something went wrong</h1>
        <p className="text-muted-foreground">Please try refreshing the page.</p>
      </div>
    )
  }

  const { data } = loadState
  const { id: siteId, name: siteName } = siteConfig
  const listingUrl = getFeaturedOnBadgeListingUrl({
    listingBasePath: siteConfig.listingRouteBasePath,
    listingDetailSuffix: siteConfig.sitemap.listingDetailSuffix,
    publicUrl: siteConfig.publicUrl,
    slug: data.slug
  })

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-8">
        <div className="flex items-center gap-3">
          <Link href="/submit" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <h1 className="text-xl font-semibold">Verify &amp; Publish</h1>
        </div>

        <p className="text-sm text-muted-foreground">
          Verifying <strong>{data.name}</strong> ({data.website})
        </p>

        <section className="space-y-4 rounded-lg border border-border p-6">
          <h2 className="flex items-center gap-2 font-semibold">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              1
            </span>
            Add the badge to your site
          </h2>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                theme === 'light'
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-transparent text-muted-foreground hover:bg-muted'
              }`}
            >
              Light
            </button>
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${
                theme === 'dark'
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-transparent text-muted-foreground hover:bg-muted'
              }`}
            >
              Dark
            </button>
          </div>

          <div className="flex items-center justify-center rounded-md border border-border bg-muted/50 p-6">
            <BadgePreview
              badgeKey={siteConfig.badges.featuredOn[theme]}
              siteId={siteId}
              theme={theme}
            />
          </div>

          <CopySnippet
            badgeKey={siteConfig.badges.featuredOn[theme]}
            listingUrl={listingUrl}
            token={token}
            siteId={siteId}
            siteName={siteName}
            theme={theme}
          />
        </section>

        <section className="space-y-4 rounded-lg border border-border p-6">
          <h2 className="flex items-center gap-2 font-semibold">
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              2
            </span>
            Click verify when badge is live
          </h2>
          <p className="text-sm text-muted-foreground">
            Once the badge is published on your site, click below. We&apos;ll scan your page for the
            embed code and confirm your listing.
          </p>
          <VerifyButton token={token} verifyEndpoint={verifyEndpoint} />
        </section>

        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium hover:text-foreground">
            Troubleshooting
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Paste the snippet in the HTML of your homepage, not inside an iframe.</li>
            <li>
              Make sure the{' '}
              <code className="rounded bg-muted px-1 font-mono">data-verify-token</code> attribute
              is present and unchanged.
            </li>
            <li>Your site must be publicly accessible, not behind a login or challenge page.</li>
            <li>
              DNS changes can take up to 48 hours to propagate, so wait before retrying if you just
              published the page.
            </li>
          </ul>
        </details>
      </div>
    </div>
  )
}

export default SubmitVerifyPageRoute
