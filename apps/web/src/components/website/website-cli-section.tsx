import { Terminal } from 'lucide-react'
import type { ComponentType } from 'react'
import { siteContent } from '../../lib/site/site-content'

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

export function WebsiteCliSection({ website, slots: { CopyButton } }: WebsiteCliSectionProps) {
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
          <div className="flex items-center justify-center size-10 rounded-xl bg-success/10">
            <Terminal className="size-5 text-success" aria-hidden />
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

        <div className="flex items-center gap-2 rounded-xl bg-muted border border-border px-4 py-3">
          <span className="select-none text-success font-mono text-sm" aria-hidden="true">
            $
          </span>
          <span className="flex-1 text-foreground font-mono text-sm truncate">
            {installCommand}
          </span>
          <CopyButton text={installCommand} variant="terminal" />
        </div>
      </div>
    </section>
  )
}
