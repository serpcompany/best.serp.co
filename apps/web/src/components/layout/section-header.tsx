import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type SectionHeaderProps = {
  action?: { href: string; label: string }
  className?: string
  description?: ReactNode
  id?: string
  title: ReactNode
}

/**
 * A section's title and description, with a "View all"-style link on the right (serplists'
 * `SectionHeader`, #257). Give it an `id` and its section `aria-labelledby` to name the region;
 * the title keeps clear of the sticky header when a link jumps to it (`#all-products`).
 */
export function SectionHeader({ action, className, description, id, title }: SectionHeaderProps) {
  return (
    <div
      className={cn('mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-2', className)}
      data-slot="section-header"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h2
          className="scroll-mt-20 text-xl font-semibold tracking-tight text-balance sm:text-2xl"
          id={id}
        >
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? (
        <Link
          href={action.href}
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            '-mr-2 text-muted-foreground'
          )}
        >
          {action.label}
          <ArrowRight data-icon="inline-end" />
        </Link>
      ) : null}
    </div>
  )
}
