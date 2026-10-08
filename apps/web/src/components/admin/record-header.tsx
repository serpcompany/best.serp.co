import type { ReactNode } from 'react'
import { ProductLogo } from './product-cell'

/**
 * The heading row of a review or listing page (#70 screens 11 and 12): the logo, the name with
 * its status chips, a meta line, and the actions. From lg up the actions stay on one row beside
 * the title, and a long name truncates instead of pushing a button onto a second row (#64
 * review). Below lg the row stacks.
 */
export function RecordHeader({
  actions,
  chips,
  logoUrl,
  meta,
  name,
  website
}: {
  actions?: ReactNode
  chips?: ReactNode
  logoUrl?: string | null
  meta: ReactNode
  name: string
  website: string
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="flex min-w-0 items-start gap-3 lg:flex-1">
        <ProductLogo
          className="rounded-lg"
          logoUrl={logoUrl}
          name={name}
          size={48}
          website={website}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 max-w-full truncate text-2xl font-semibold tracking-tight">
              {name}
            </h1>
            {chips}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{meta}</p>
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap gap-2 lg:shrink-0 lg:flex-nowrap">{actions}</div>
      ) : null}
    </div>
  )
}
