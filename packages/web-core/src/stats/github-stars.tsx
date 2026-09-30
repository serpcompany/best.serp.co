'use client'

import { SiGithub } from '@icons-pack/react-simple-icons'
import { hasConfiguredPublicSocialLinks, siteConfig } from '@serpdirectory/web-core/site-config'
import { StarIcon } from 'lucide-react'
import Link from 'next/link'

interface StarsProps {
  mobileCompact?: boolean
}

/**
 * Static GitHub link used in the header without live API fetching.
 */
export function GithubStars({ mobileCompact = false }: StarsProps) {
  if (!hasConfiguredPublicSocialLinks(siteConfig)) {
    return null
  }

  const className = mobileCompact
    ? '!no-underline inline-flex items-center gap-2 h-9 px-3 text-sm font-bold text-muted-foreground hover:text-foreground sm:bg-secondary hover:sm:bg-accent sm:text-foreground sm:rounded-none sm:border sm:border-border hover:sm:border-foreground/20 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    : '!no-underline inline-flex items-center gap-2 h-9 px-3 bg-secondary hover:bg-accent text-sm font-bold text-foreground rounded-none border border-border hover:border-foreground/20 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <div className={mobileCompact ? undefined : 'flex items-center justify-center'}>
      <Link
        href={siteConfig.githubRepoUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        aria-label="View the project on GitHub"
      >
        <SiGithub className="size-4" aria-hidden="true" />
        <StarIcon className="size-3.5" aria-hidden="true" />
        <span>{mobileCompact ? 'GitHub' : 'Star on GitHub'}</span>
      </Link>
    </div>
  )
}
