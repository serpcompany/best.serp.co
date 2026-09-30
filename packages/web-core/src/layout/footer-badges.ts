import { resolveDrBadgeConfig } from './dr-badge'

export type FooterBadgeConfig = {
  alt: string
  href: string
  src: string
  title?: string
}

const featuredOnSerpCoBadgesByDomain: Record<string, FooterBadgeConfig> = {
  'serp.ai': {
    alt: 'Featured on serp.co',
    href: 'https://serp.co/products/serp.ai/reviews/',
    src: 'https://serp.co/badge/featured-on-serp.co-light.svg',
    title: 'Featured on serp.co'
  }
}

function resolveFeaturedOnSerpCoBadgeConfig(domain: string): FooterBadgeConfig | undefined {
  return featuredOnSerpCoBadgesByDomain[domain.toLowerCase()]
}

export function resolveFooterBadgeConfigs(domain: string): FooterBadgeConfig[] {
  return [resolveFeaturedOnSerpCoBadgeConfig(domain), resolveDrBadgeConfig(domain)].filter(
    (badge): badge is FooterBadgeConfig => Boolean(badge)
  )
}
