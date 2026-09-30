import type { SiteNetworkLink, SiteOwnedContent } from '@serpdirectory/site-contract/types'
import {
  hasConfiguredGitHubIssueTarget,
  hasConfiguredPublicSocialLinks,
  siteConfig
} from './site-config'
import { siteContent } from './site-content'

export type NetworkLink = SiteNetworkLink

function resolveDefaultNetworkLinks(): NetworkLink[] {
  if (!hasConfiguredPublicSocialLinks(siteConfig)) {
    return []
  }

  const links: NetworkLink[] = [
    {
      description: `Browse the source, starter structure, and build workflow for ${siteConfig.name}.`,
      href: siteConfig.githubRepoUrl,
      label: 'Repository',
      title: 'Site repository'
    }
  ]

  const githubIssuesUrl = siteConfig.githubIssuesUrl

  if (hasConfiguredGitHubIssueTarget(siteConfig) && githubIssuesUrl) {
    links.push({
      description: 'See open follow-up work, submission discussions, and compatibility tasks.',
      href: githubIssuesUrl,
      label: 'Issues',
      title: 'Issue tracker'
    })
  }

  links.push({
    description: 'Open the broader GitHub profile behind this site and any related projects.',
    href: siteConfig.githubUrl,
    label: 'GitHub',
    title: 'GitHub profile'
  })

  return links
}

export function resolveNetworkLinks(content: SiteOwnedContent = siteContent): NetworkLink[] {
  const links = [...resolveDefaultNetworkLinks(), ...content.networkLinks]
  const dedupedLinks = new Map<string, NetworkLink>()

  for (const link of links) {
    dedupedLinks.set(link.href, link)
  }

  return Array.from(dedupedLinks.values())
}

export const networkLinks: NetworkLink[] = resolveNetworkLinks()
