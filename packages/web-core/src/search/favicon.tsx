'use client'

import { ListingImage } from '../ui/listing-image'

interface FaviconProps {
  website: string
  className?: string
  title?: string
}

/**
 * A search suggestion's listing mark: autocomplete results carry no logo, so it is the #86 tile,
 * through the shared listing image (#122).
 */
export function Favicon({ website, className = 'h-4 w-4', title }: FaviconProps) {
  // Size from the Tailwind class (h-4 → 16px).
  const sizeMatch = className.match(/[hw]-(\d+)/)
  const size = sizeMatch ? Number.parseInt(sizeMatch[1] ?? '4', 10) * 4 : 16

  return <ListingImage name={title || website} size={size} className="rounded-sm" />
}
