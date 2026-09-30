import type { SiteExternalResourceIcon } from '@serpdirectory/site-contract/types'
import type { LucideIcon } from 'lucide-react'
import { Chrome, Code2, Command, GitBranch, Terminal } from 'lucide-react'
import { siteContent } from './site-content'

export interface ExternalResource {
  description: string
  icon: LucideIcon
  imageAlt?: string
  imageSrc?: string
  name: string
  slug: string
  url: string
}

const resourceIconsByName: Record<SiteExternalResourceIcon, LucideIcon> = {
  chrome: Chrome,
  code2: Code2,
  command: Command,
  gitBranch: GitBranch,
  terminal: Terminal
}

export const externalResources: ExternalResource[] = siteContent.externalResources.map(
  resource => ({
    description: resource.description,
    icon: resourceIconsByName[resource.icon],
    imageAlt: resource.imageAlt,
    imageSrc: resource.imageSrc,
    name: resource.name,
    slug: resource.slug,
    url: resource.href
  })
)
