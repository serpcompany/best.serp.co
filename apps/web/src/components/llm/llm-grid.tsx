'use client'

import { CardGrid } from '@/components/layout/card-grid'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { ListingCard } from './listing-card'

interface LLMGridProps {
  items: WebsiteRelatedCardMetadata[]
  className?: string
  /** Cards past this many stay in the HTML but hidden, so the full page is crawlable. */
  maxItems?: number
  analyticsSource?: string
}

/** Listing cards in the shared card grid (#257): one, two, then three columns. */
export function LLMGrid({ items = [], className, maxItems, analyticsSource }: LLMGridProps) {
  if (!items?.length) {
    return null
  }

  return (
    <CardGrid as="ul" className={className}>
      {items.map((item, index) => {
        if (!item?.slug) return null
        const isVisible = !maxItems || index < maxItems
        return (
          // min-w-0: the phone grid's one column is `auto`, so a long name would widen it.
          <li key={item.slug} hidden={!isVisible} className="min-w-0">
            <ListingCard item={item} analyticsSource={analyticsSource} />
          </li>
        )
      })}
    </CardGrid>
  )
}
