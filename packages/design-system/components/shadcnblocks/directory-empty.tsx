import type { ComponentType, ReactNode, SVGProps } from 'react'
import { cn } from '../../lib/utils'
import { Button } from '../shadcn/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '../shadcn/empty'

// Source reference: adapted from ShadcnBlocks empty-empty-search-5 and empty-empty-actions-1.
interface DirectoryEmptyAction {
  label: string
  onClick?: () => void
  href?: string
  slot?: ReactNode
  variant?: React.ComponentProps<typeof Button>['variant']
}

interface DirectoryEmptyProps {
  title: string
  description: ReactNode
  icon?: ComponentType<SVGProps<SVGSVGElement>>
  action?: DirectoryEmptyAction
  secondaryAction?: DirectoryEmptyAction
  className?: string
  iconClassName?: string
  iconContainerClassName?: string
  titleClassName?: string
  descriptionClassName?: string
}

function renderAction(
  action: DirectoryEmptyAction,
  fallbackVariant?: DirectoryEmptyAction['variant']
) {
  if (action.slot) {
    return (
      <Button asChild variant={action.variant ?? fallbackVariant}>
        {action.slot}
      </Button>
    )
  }

  if (action.href) {
    return (
      <Button asChild variant={action.variant ?? fallbackVariant}>
        <a href={action.href}>{action.label}</a>
      </Button>
    )
  }

  return (
    <Button type="button" onClick={action.onClick} variant={action.variant ?? fallbackVariant}>
      {action.label}
    </Button>
  )
}

function DirectoryEmpty({
  title,
  description,
  icon: Icon,
  action,
  secondaryAction,
  className,
  iconClassName,
  iconContainerClassName,
  titleClassName,
  descriptionClassName
}: DirectoryEmptyProps) {
  return (
    <Empty
      className={cn(
        'h-[50vh] flex-none gap-0 rounded-none border-none p-0 text-center [text-wrap:wrap] md:p-0',
        className
      )}
    >
      <EmptyHeader className="max-w-none gap-0">
        {Icon ? (
          <EmptyMedia className={cn('mb-0', iconContainerClassName)}>
            <Icon
              aria-hidden="true"
              className={cn('mb-4 h-16 w-16 text-muted-foreground', iconClassName)}
            />
          </EmptyMedia>
        ) : null}
        <EmptyTitle className={cn('mb-2 text-2xl font-bold', titleClassName)}>{title}</EmptyTitle>
        <EmptyDescription className={cn('mb-4 max-w-md', descriptionClassName)}>
          {description}
        </EmptyDescription>
      </EmptyHeader>
      {action || secondaryAction ? (
        <EmptyContent className="max-w-none gap-0">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {action ? renderAction(action) : null}
            {secondaryAction ? renderAction(secondaryAction, 'outline') : null}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

export { DirectoryEmpty }
export type { DirectoryEmptyAction, DirectoryEmptyProps }
