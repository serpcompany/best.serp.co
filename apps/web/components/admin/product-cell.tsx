import { FaviconWithFallback } from '@serpdirectory/web-core/ui/favicon-with-fallback'
import Link from 'next/link'

/** A product's logo, with the site's checked-in fallback for a missing or broken image. */
export function ProductLogo({
  className = 'rounded-sm',
  logoUrl,
  name,
  size = 32,
  website
}: {
  className?: string
  logoUrl?: string | null
  name: string
  size?: number
  website: string
}) {
  return (
    <FaviconWithFallback
      className={className}
      logoUrl={logoUrl ?? undefined}
      name={name}
      size={size}
      website={website}
    />
  )
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
