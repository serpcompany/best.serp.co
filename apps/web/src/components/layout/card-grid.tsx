import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const cardGridVariants = cva('grid gap-4', {
  variants: {
    columns: {
      1: 'grid-cols-1',
      2: 'sm:grid-cols-2',
      3: 'sm:grid-cols-2 lg:grid-cols-3'
    }
  },
  defaultVariants: {
    columns: 3
  }
})

type CardGridProps = HTMLAttributes<HTMLUListElement> & VariantProps<typeof cardGridVariants>

/**
 * The responsive card grid (serplists' `CardGrid`, #257): one column on phones, two on tablets,
 * three on wide screens. A list, so each card is an `li`.
 */
export function CardGrid({ className, columns, ...props }: CardGridProps) {
  return (
    <ul className={cn(cardGridVariants({ columns }), className)} data-slot="card-grid" {...props} />
  )
}
