import Link from 'next/link'
import { ListingImage } from '@/components/listing/listing-image'

/**
 * A product's logo on the admin screens: the shared listing image (#122), so a missing or broken
 * logo is the #86 tile, never alt text. `website` is accepted for the callers and not rendered.
 */
export function ProductLogo({
  className = 'rounded-sm',
  logoUrl,
  name,
  size = 32
}: {
  className?: string
  logoUrl?: string | null
  name: string
  size?: number
  website: string
}) {
  return <ListingImage className={className} name={name} size={size} src={logoUrl} />
}

/** The product cell of the admin tables: logo, linked name, and a second line. */
export function ProductCell({
  href,
  logoUrl,
  name,
  sub,
  website
}: {
  href: string
  logoUrl?: string | null
  name: string
  sub: string
  website: string
}) {
  return (
    <div className="flex items-center gap-3">
      <ProductLogo logoUrl={logoUrl} name={name} website={website} />
      <div className="min-w-0">
        <Link href={href} className="font-medium hover:underline">
          {name}
        </Link>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
    </div>
  )
}
