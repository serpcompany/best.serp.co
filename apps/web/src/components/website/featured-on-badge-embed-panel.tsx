'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

type BadgeTheme = 'light' | 'dark'

const FEATURED_ON_BADGE_WIDTH = 200
const FEATURED_ON_BADGE_HEIGHT = 50

export type FeaturedOnBadgeEmbedPanelProps = {
  badgePreviewUrls?: Record<BadgeTheme, string>
  badgeUrls: Record<BadgeTheme, string>
  listingUrl: string
  siteId: string
  siteName: string
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function buildFeaturedOnBadgeEmbedHtml({
  badgeUrl,
  listingUrl,
  siteName
}: {
  badgeUrl: string
  listingUrl: string
  siteName: string
}): string {
  const safeListingUrl = escapeHtmlAttribute(listingUrl)
  const safeBadgeUrl = escapeHtmlAttribute(badgeUrl)
  const safeSiteName = escapeHtmlAttribute(siteName)

  return `<a href="${safeListingUrl}" target="_blank" rel="noopener noreferrer" title="Featured on ${safeSiteName}">
  <img src="${safeBadgeUrl}" alt="Featured on ${safeSiteName}" width="${FEATURED_ON_BADGE_WIDTH}" height="${FEATURED_ON_BADGE_HEIGHT}" />
</a>`
}

export function FeaturedOnBadgeEmbedPanel({
  badgePreviewUrls,
  badgeUrls,
  listingUrl,
  siteId,
  siteName
}: FeaturedOnBadgeEmbedPanelProps) {
  const [copiedTheme, setCopiedTheme] = useState<BadgeTheme | null>(null)
  const previewUrls = badgePreviewUrls ?? badgeUrls

  async function handleCopy(theme: BadgeTheme, embedHtml: string) {
    await navigator.clipboard.writeText(embedHtml)
    setCopiedTheme(theme)
    setTimeout(() => setCopiedTheme(null), 2000)
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card/50 p-6 backdrop-blur-sm">
      <h2 className="text-sm font-semibold text-foreground">
        Add a badge to your website. Click the badge below to copy the code.
      </h2>
      {(['light', 'dark'] as const).map(theme => {
        const embedHtml = buildFeaturedOnBadgeEmbedHtml({
          badgeUrl: badgeUrls[theme],
          listingUrl,
          siteName
        })

        return (
          <Button
            key={`${siteId}-${theme}`}
            variant="ghost"
            onClick={() => void handleCopy(theme, embedHtml)}
            className="mt-4 flex h-auto max-w-full p-0"
            aria-label={`Copy ${theme} badge embed code`}
            title={`Copy ${theme} badge embed code`}
          >
            <img
              src={previewUrls[theme]}
              alt={`${theme === 'light' ? 'Light' : 'Dark'} Featured on ${siteName} badge`}
              width={FEATURED_ON_BADGE_WIDTH}
              height={FEATURED_ON_BADGE_HEIGHT}
              className="h-auto max-w-full"
            />
          </Button>
        )
      })}
      <p className="mt-2 min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {copiedTheme ? `Copied ${copiedTheme} badge` : null}
      </p>
    </div>
  )
}
