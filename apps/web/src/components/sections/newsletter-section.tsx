import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getRoute } from '../../lib/routing/routes'
import { siteCopy } from '../../lib/site/site-copy'
import { DirectoryCtaBand } from './directory-home-section'

export function NewsletterSection() {
  return (
    <DirectoryCtaBand>
      <div className="mx-auto max-w-2xl px-6 text-center space-y-4">
        <p className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground">
          Keep The Directory Growing
        </p>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Know a site that should be listed?
          </h2>
          <p className="text-sm text-muted-foreground sm:text-base">
            Submit it through GitHub and keep the directory fully reviewable, low-cost, and
            static-friendly.
          </p>
        </div>
        <div className="pt-2">
          <Link
            href={getRoute('submit')}
            className={cn(
              buttonVariants(),
              'h-auto bg-foreground px-5 py-2.5 text-sm font-bold text-background shadow-none transition-colors hover:bg-foreground/90'
            )}
          >
            {siteCopy.submitLabel}
          </Link>
        </div>
      </div>
    </DirectoryCtaBand>
  )
}
