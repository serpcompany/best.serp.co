import { Terminal } from 'lucide-react'
import type { ComponentType } from 'react'
import { siteContent } from '../site-content'

type CopyButtonProps = {
  text: string
  variant?: 'terminal'
}

type WebsiteCliWebsite = {
  slug: string
}

export interface WebsiteCliSectionProps {
  website: WebsiteCliWebsite
  slots: {
    CopyButton: ComponentType<CopyButtonProps>
  }
}

export function WebsiteCliSection({
  website,
  slots: { CopyButton },
}: WebsiteCliSectionProps) {
  const cliInstall = siteContent.listingCliInstall

  if (!cliInstall) {
    return null
  }

  const cliSlug = cliInstall.installTargetByListingSlug[website.slug]

  if (!cliSlug) return null

  const installCommand = `${cliInstall.commandPrefix} ${cliSlug}`

  return (
    <section className="animate-fade-in-up opacity-0 stagger-2">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-xl bg-emerald-500/10">
            <Terminal className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          </div>
          <div>
            <h2 className="text-xl font-bold text-pretty scroll-mt-20" id="install">
              CLI Install Command
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Add this documentation source directly to your environment
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-xl bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-4 py-3">
          <span
            className="select-none text-emerald-600 dark:text-emerald-500/70 font-mono text-sm"
            aria-hidden="true"
          >
            $
          </span>
          <span className="flex-1 text-zinc-800 dark:text-zinc-100 font-mono text-sm truncate">
            {installCommand}
          </span>
          <CopyButton text={installCommand} variant="terminal" />
        </div>
      </div>
    </section>
  )
}
