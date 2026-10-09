'use client'

import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { FavoriteButton } from '../favorites/favorite-button'
import { ListingImage } from '../listing/listing-image'

interface ListingCardProps {
  item: WebsiteRelatedCardMetadata
  analyticsSource?: string
}

function stripHtmlTags(html: string | null | undefined): string {
  if (!html) return ''

  let text = ''
  let insideTag = false

  for (const char of html) {
    if (char === '<') {
      insideTag = true
      continue
    }

    if (insideTag) {
      if (char === '>') {
        insideTag = false
      }
      continue
    }

    text += char
  }

  return text.trim()
}

/**
 * A listing as a card, after serp.co's `CatalogListing` (#257): its logo, its name, and a
 * two-line description. The name links to the listing and covers the card; the favorite button
 * sits above that link.
 */
export function ListingCard({ item, analyticsSource }: ListingCardProps) {
  return (
    <div className="group relative h-full rounded-xl">
      <Card className="h-full flex-row items-start gap-4 p-4 text-base ring-foreground/10 transition-shadow group-hover:ring-border sm:p-5">
        {/* Wrapped: Card drops its top padding when an image is its first child. */}
        <div className="shrink-0">
          <ListingImage name={item.name} src={item.media?.logo} size={48} className="rounded-lg" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate font-semibold">
              <Link
                href={getRoute('listing.detail', { slug: item.slug })}
                className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
                data-analytics="website-click"
                data-website-name={item.name}
                data-website-slug={item.slug}
                data-source={analyticsSource || 'grid-default'}
              >
                {item.name}
              </Link>
            </h3>
            {item.isUnofficial ? <Badge variant="outline">Unofficial</Badge> : null}
          </div>
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {stripHtmlTags(item.description)}
          </p>
        </div>
        <div className="relative z-10 shrink-0">
          <FavoriteButton slug={item.slug} size="sm" variant="ghost" />
        </div>
      </Card>
    </div>
  )
}
