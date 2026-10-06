'use client'

import { AspectRatio } from '@serpdirectory/design-system/aspect-ratio'
import { cn } from '@serpdirectory/design-system/lib/utils'
import { useCallback, useState } from 'react'
import {
  LISTING_LOGO_FALLBACK_PATH,
  shouldUseProvidedListingLogo
} from '../listing-logo-presentation'

/**
 * The one way a listing image renders (serpcompany/best.serp.co#122): cards, the detail page's
 * logo and featured image, search results, and the admin, account, and submit previews. A
 * listing image never shows its alt text or a broken-image icon:
 *
 * - no image (no hosted key): the server renders the #86 tile;
 * - a load error after hydration: `onError` swaps in the tile, in the same box (no layout shift);
 * - a load error before hydration, when no listener was attached yet: the ref finds the broken
 *   image on mount and swaps it, and until then its `::after` (drawn only for a broken image in
 *   Chromium and Firefox) paints the tile over the icon and the alt text;
 * - in every engine, Safari included, and without JavaScript: a broken image draws its alt text
 *   in the image's own `color`, which is transparent and clipped to the box, so the alt text
 *   stays in the markup for assistive technology but is never visible (#123 review S1).
 *
 * `scripts/listing-image-guard.test.ts` fails when a listing image renders anywhere else.
 */

export type ListingImageKind = 'logo' | 'image'

/** Marks every listing image in the DOM, for the e2e suite. */
export const LISTING_IMAGE_ATTRIBUTE = 'data-listing-image'
/** Featured images are social images: 1200×630, so a swap to the tile keeps the box. */
export const LISTING_FEATURED_IMAGE_RATIO = 1200 / 630

// Full class names, so Tailwind finds them. Alt text is drawn in the image's `color`: never seen.
const hiddenAltText = 'overflow-hidden text-transparent'
// The tile over a broken image, before hydration.
const brokenLogoCover =
  "relative after:absolute after:inset-0 after:bg-card after:bg-[url('/listing-logos/favicon-fallback-512x512.png')] after:bg-contain after:bg-center after:bg-no-repeat after:content-['']"
const brokenImageCover =
  "relative after:absolute after:inset-0 after:bg-muted after:bg-[url('/listing-logos/favicon-fallback-512x512.png')] after:bg-[length:auto_45%] after:bg-center after:bg-no-repeat after:content-['']"

export interface ListingImageProps {
  className?: string
  kind?: ListingImageKind
  /** The listing's name, for the alt text. */
  name: string
  /** Logos only: the rendered width and height in pixels. */
  size?: number
  /** The image URL; nothing, or a value that is not an image reference, renders the tile. */
  src?: string | null
}

export function ListingImage({
  className,
  kind = 'logo',
  name,
  size = 32,
  src
}: ListingImageProps) {
  const provided = src && shouldUseProvidedListingLogo(src) ? src : null
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showTile = !provided || failedSrc === provided
  const fail = useCallback(() => {
    if (provided) setFailedSrc(provided)
  }, [provided])
  // An image that failed before hydration fired `error` with no listener: check it on mount.
  // `decode()` rejects only for a broken image (an SVG without a size also has naturalWidth 0).
  const checkLoaded = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image || !provided || image.getAttribute('src') !== provided) return
      if (image.complete && image.naturalWidth === 0) image.decode().catch(fail)
    },
    [fail, provided]
  )

  const shared = {
    [LISTING_IMAGE_ATTRIBUTE]: kind,
    'data-fallback': showTile ? '' : undefined,
    decoding: 'async',
    loading: 'lazy',
    onError: showTile ? undefined : fail,
    ref: showTile ? undefined : checkLoaded,
    // Never send our URL as the referrer to another host (#63).
    referrerPolicy: 'no-referrer',
    src: showTile ? LISTING_LOGO_FALLBACK_PATH : provided
  } as const

  if (kind === 'image') {
    return (
      <AspectRatio ratio={LISTING_FEATURED_IMAGE_RATIO} className={cn('bg-muted', className)}>
        <img
          {...shared}
          alt={showTile ? '' : `${name} featured image`}
          className={cn(
            'size-full object-contain',
            hiddenAltText,
            showTile ? 'p-[10%]' : brokenImageCover
          )}
        />
      </AspectRatio>
    )
  }

  return (
    <img
      {...shared}
      alt={showTile ? `${name} fallback logo` : `${name} logo`}
      width={size}
      height={size}
      className={cn(
        'shrink-0 object-contain',
        hiddenAltText,
        !showTile && brokenLogoCover,
        className
      )}
      style={{ height: size, width: size }}
    />
  )
}
