'use client'

import { cn } from '@serpdirectory/design-system/lib/utils'
import { DirectoryProductList } from '@serpdirectory/design-system/shadcnblocks/directory-product-list'
import type { WebsiteRelatedCardMetadata } from '../content-query'
import { CompactListingCard, ListingCard } from './listing-card'

interface LLMGridProps {
  items: WebsiteRelatedCardMetadata[]
  variant?: 'default' | 'compact'
  className?: string
  maxItems?: number
  animateIn?: boolean
  analyticsSource?: string
  overrideGrid?: boolean
}

export function LLMGrid({
  items = [],
  variant = 'default',
  className,
  maxItems,
  animateIn = true,
  analyticsSource,
  overrideGrid = false
}: LLMGridProps) {
  if (!items?.length) {
    return null
  }

  const getStaggerClass = (index: number) => {
    const staggerIndex = Math.min(index, 7) + 1
    return `stagger-${staggerIndex}`
  }

  if (variant === 'compact') {
    return (
      <div className={cn('space-y-4', className)}>
        {items.map((item, index) => {
          if (!item?.slug) return null
          return (
            <CompactListingCard
              className={cn(
                animateIn && 'animate-fade-in-up opacity-0',
                animateIn && getStaggerClass(index)
              )}
              item={item}
              key={item.slug}
              analyticsSource={analyticsSource}
            />
          )
        })}
      </div>
    )
  }

  return (
    <DirectoryProductList className={className} overrideGrid={overrideGrid}>
      {items.map((item, index) => {
        if (!item?.slug) return null

        const isVisible = !maxItems || index < maxItems
        const collapseToWideScreensOnly = maxItems === undefined && index >= 6

        return (
          <div
            aria-hidden={!isVisible}
            inert={!isVisible}
            key={item.slug}
            className={cn(
              'transition-all duration-300 ease-out',
              isVisible ? 'scale-100' : 'scale-95 absolute pointer-events-none',
              animateIn && isVisible && 'animate-fade-in-up opacity-0',
              animateIn && isVisible && getStaggerClass(index),
              collapseToWideScreensOnly && isVisible && 'hidden 4xl:block'
            )}
          >
            <ListingCard item={item} analyticsSource={analyticsSource} />
          </div>
        )
      })}
    </DirectoryProductList>
  )
}
