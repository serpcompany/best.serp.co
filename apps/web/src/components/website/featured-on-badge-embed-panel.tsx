'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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
    // One badge fills the listing page's badge card (#535): the one for the page's theme, by CSS,
    // so the server's HTML stays the same for both; a click copies the code of the one shown. The
    // card around it brings the heading.
    <div className="flex flex-col gap-2">
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
            className={cn(
              'h-auto w-full p-0',
              theme === 'light' ? 'dark:hidden' : 'hidden dark:flex'
            )}
            aria-label={`Copy ${theme} badge embed code`}
            title={`Copy ${theme} badge embed code`}
          >
            {/* The card's full width, at the badge's shape; the copied code keeps 200 by 50. */}
            <img
              src={previewUrls[theme]}
              alt={`${theme === 'light' ? 'Light' : 'Dark'} Featured on ${siteName} badge`}
              width={FEATURED_ON_BADGE_WIDTH}
              height={FEATURED_ON_BADGE_HEIGHT}
              className="h-auto w-full"
            />
          </Button>
        )
      })}
      <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {copiedTheme ? `Copied ${copiedTheme} badge` : null}
      </p>
    </div>
  )
}
