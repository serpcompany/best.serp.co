import type { VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { pageHeroVariants } from './page-shell.styles'

type PageHeroProps = VariantProps<typeof pageHeroVariants> & {
  actions?: ReactNode
  chips?: ReactNode
  className?: string
  description?: ReactNode
  eyebrow?: ReactNode
  search?: ReactNode
  title: ReactNode
}

/**
 * A page's opening (serplists' `PageHero`, #257): an eyebrow badge, the page's `h1`, a muted
 * description, then the actions, a search field and chips.
 */
export function PageHero({
  actions,
  align,
  chips,
  className,
  description,
  eyebrow,
  search,
  title
}: PageHeroProps) {
  const centered = align === 'center'
  return (
    <div className={cn(pageHeroVariants({ align }), className)} data-slot="page-hero">
      {eyebrow ? <Badge variant="secondary">{eyebrow}</Badge> : null}
      <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
        {title}
      </h1>
      {description ? (
        <p className="max-w-2xl text-base text-balance text-muted-foreground sm:text-lg">
          {description}
        </p>
      ) : null}
      {actions ? (
        <div className={cn('mt-2 flex flex-wrap gap-2', centered && 'justify-center')}>
          {actions}
        </div>
      ) : null}
      {search ? <div className="mt-2 w-full max-w-xl">{search}</div> : null}
      {chips ? (
        <div className={cn('flex max-w-3xl flex-wrap gap-2', centered && 'justify-center')}>
          {chips}
        </div>
      ) : null}
    </div>
  )
}
