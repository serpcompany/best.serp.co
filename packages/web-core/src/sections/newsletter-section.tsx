import { Button } from '@serpdirectory/design-system/button'
import { DirectoryCtaBand } from '@serpdirectory/design-system/shadcnblocks/directory-home-section'
import Link from 'next/link'
import { getRoute } from '../routes'
import { siteCopy } from '../site-copy'

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
          <Button
            asChild
            className="h-auto rounded-none bg-foreground px-5 py-2.5 text-sm font-bold text-background shadow-none transition-colors hover:bg-foreground/90 active:scale-100"
          >
            <Link href={getRoute('submit')}>{siteCopy.submitLabel}</Link>
          </Button>
        </div>
      </div>
    </DirectoryCtaBand>
  )
}
