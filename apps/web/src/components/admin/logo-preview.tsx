'use client'

import { ProductLogo } from './product-cell'

/**
 * A logo field's preview (#96 review S9): the hosted copy when there is one, otherwise the
 * fallback tile with a link to the source. A source on someone else's host is never loaded as
 * an image on an admin screen.
 */
export function LogoPreview({
  hosted,
  name,
  size = 64,
  source,
  website
}: {
  hosted: string | null
  name: string
  size?: number
  source: string
  website: string
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <ProductLogo
        className="rounded-lg"
        logoUrl={hosted}
        name={name}
        size={size}
        website={website}
      />
      {!hosted && source.trim() ? (
        <a
          className="text-xs text-muted-foreground underline underline-offset-2"
          href={source.trim()}
          rel="noreferrer noopener"
          target="_blank"
        >
          Source image
        </a>
      ) : null}
    </div>
  )
}
