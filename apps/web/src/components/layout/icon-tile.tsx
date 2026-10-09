import type { VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { iconTileVariants } from './page-shell.styles'

type IconTileProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof iconTileVariants>

/** An icon on a small muted square (serplists' `IconTile`, #268). Decorative. */
export function IconTile({ children, className, size, tone, ...props }: IconTileProps) {
  return (
    <div
      aria-hidden="true"
      data-slot="icon-tile"
      className={cn(iconTileVariants({ size, tone }), className)}
      {...props}
    >
      {children}
    </div>
  )
}
