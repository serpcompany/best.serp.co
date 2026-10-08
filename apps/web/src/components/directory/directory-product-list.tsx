import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

// Source reference: adapted from ShadcnBlocks product-list3 and product-list5.
interface DirectoryProductCardProps {
  media: ReactNode
  title: ReactNode
  description?: ReactNode
  badge?: ReactNode
  action?: ReactNode
  className?: string
  contentClassName?: string
}

interface DirectoryProductRowProps extends DirectoryProductCardProps {
  trailing?: ReactNode
}

interface DirectoryProductListProps {
  children: ReactNode
  className?: string
  overrideGrid?: boolean
}

function DirectoryProductList({
  children,
  className,
  overrideGrid = false
}: DirectoryProductListProps) {
  return (
    <div
      className={
        overrideGrid
          ? className
          : cn(
              'grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 4xl:grid-cols-8',
              className
            )
      }
    >
      {children}
    </div>
  )
}

function DirectoryProductCard({
  media,
  title,
  description,
  badge,
  action,
  className,
  contentClassName
}: DirectoryProductCardProps) {
  return (
    <Card
      className={cn(
        'relative h-full rounded-none border-border/50 p-4 transition-all duration-300 ease-out hover:-translate-y-1 hover:border-foreground/10 hover:shadow-lg',
        className
      )}
    >
      <CardContent className={cn('flex h-full flex-col gap-1.5 p-0', contentClassName)}>
        <div className="flex items-start justify-between">
          {media}
          {action}
        </div>
        <div className="flex items-center gap-2">
          <h3
            data-slot="card-title"
            className="truncate font-bold leading-none text-xs sm:text-sm md:text-base"
          >
            {title}
          </h3>
          {badge}
        </div>
        {description ? (
          <div className="line-clamp-2 text-xs text-muted-foreground sm:text-sm">{description}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DirectoryProductRow({
  media,
  title,
  description,
  badge,
  trailing,
  className,
  contentClassName
}: DirectoryProductRowProps) {
  return (
    <div
      className={cn(
        'relative flex items-center gap-3 rounded-lg p-2 transition-all duration-200 hover:translate-x-1 hover:bg-muted/50 sm:p-2.5',
        className
      )}
    >
      {media}
      <div className={cn('min-w-0 flex-1 space-y-1', contentClassName)}>
        <div className="flex items-center gap-2">
          <h3
            data-slot="card-title"
            className="truncate font-semibold leading-none text-xs sm:text-sm md:text-base"
          >
            {title}
          </h3>
          {badge}
        </div>
        {description ? (
          <div className="text-xs text-muted-foreground sm:text-sm">{description}</div>
        ) : null}
      </div>
      {trailing ? <div className="ml-2 flex-shrink-0">{trailing}</div> : null}
    </div>
  )
}

function DirectoryProductBadge({
  children,
  className
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'border-warning/30 bg-warning/10 text-xs text-warning transition-colors hover:bg-warning/20',
        className
      )}
    >
      {children}
    </Badge>
  )
}

export type { DirectoryProductCardProps, DirectoryProductListProps, DirectoryProductRowProps }
export { DirectoryProductBadge, DirectoryProductCard, DirectoryProductList, DirectoryProductRow }
