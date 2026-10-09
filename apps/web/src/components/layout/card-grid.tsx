import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const cardGridVariants = cva('grid gap-6', {
  variants: {
    columns: {
      1: 'grid-cols-1',
      2: 'sm:grid-cols-2',
      3: 'sm:grid-cols-2 lg:grid-cols-3',
      4: 'grid-cols-2 gap-4 lg:grid-cols-4'
    }
  },
  defaultVariants: {
    columns: 3
  }
})

type CardGridProps = HTMLAttributes<HTMLElement> &
  VariantProps<typeof cardGridVariants> & {
    /** `ul` when each card is an `li` (a list of listings); `div` for cards placed directly. */
    as?: 'div' | 'ul'
  }

/**
 * The responsive card grid (serplists' `CardGrid`, #257): one column on phones, then two, then
 * three (or two then four for tiles).
 */
export function CardGrid({ as: Component = 'div', className, columns, ...props }: CardGridProps) {
  return (
    <Component
      className={cn(cardGridVariants({ columns }), className)}
      data-slot="card-grid"
      {...props}
    />
  )
}
