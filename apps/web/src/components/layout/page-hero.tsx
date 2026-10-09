import type { VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { pageHeroVariants } from './page-shell.styles'

type PageHeroProps = VariantProps<typeof pageHeroVariants> & {
  actions?: ReactNode
  className?: string
  description?: ReactNode
  eyebrow?: ReactNode
  title: ReactNode
}

/**
 * A page's opening (serplists' `PageHero`, #257): an eyebrow badge, the page's `h1`, a muted
 * description, then the actions.
 */
export function PageHero({
  actions,
  align,
  className,
  description,
  eyebrow,
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
    </div>
  )
}
