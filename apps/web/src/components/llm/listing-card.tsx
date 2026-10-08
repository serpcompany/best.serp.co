'use client'

import Link from 'next/link'
import {
  DirectoryProductBadge,
  DirectoryProductCard,
  DirectoryProductRow
} from '@/components/directory/directory-product-list'
import { cn } from '@/lib/utils'
import type { WebsiteRelatedCardMetadata } from '../../lib/directory/content-query'
import { getRoute } from '../../lib/routing/routes'
import { FavoriteButton } from '../ui/favorite-button'
import { ListingImage } from '../ui/listing-image'

interface ListingCardProps {
  item: WebsiteRelatedCardMetadata
  analyticsSource?: string
  className?: string
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

function UnofficialBadge() {
  return <DirectoryProductBadge>Unofficial</DirectoryProductBadge>
}

function ListingCardLink({
  item,
  analyticsSource,
  defaultSource
}: ListingCardProps & { defaultSource: string }) {
  return (
    <Link
      href={getRoute('listing.detail', { slug: item.slug })}
      className="block after:absolute after:inset-0 after:content-[''] z-10"
      data-analytics="website-click"
      data-website-name={item.name}
      data-website-slug={item.slug}
      data-source={analyticsSource || defaultSource}
    >
      {item.name}
    </Link>
  )
}

export function CompactListingCard({ item, analyticsSource, className }: ListingCardProps) {
  return (
    <DirectoryProductRow
      className={cn(className)}
      media={
        <ListingImage name={item.name} src={item.media?.logo} size={32} className="rounded-lg" />
      }
      title={
        <ListingCardLink
          item={item}
          analyticsSource={analyticsSource}
          defaultSource="grid-compact"
        />
      }
      badge={item.isUnofficial ? <UnofficialBadge /> : null}
      description={stripHtmlTags(item.description)}
      trailing={<FavoriteButton slug={item.slug} size="sm" variant="ghost" />}
    />
  )
}

export function ListingCard({ item, analyticsSource }: ListingCardProps) {
  return (
    <DirectoryProductCard
      media={
        <ListingImage name={item.name} src={item.media?.logo} size={32} className="rounded-lg" />
      }
      title={
        <ListingCardLink
          item={item}
          analyticsSource={analyticsSource}
          defaultSource="grid-default"
        />
      }
      badge={item.isUnofficial ? <UnofficialBadge /> : null}
      description={stripHtmlTags(item.description)}
      action={<FavoriteButton slug={item.slug} size="sm" variant="default" />}
    />
  )
}
