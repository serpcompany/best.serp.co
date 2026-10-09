import {
  SiFacebook,
  SiGithub,
  SiGoogle,
  SiInstagram,
  SiMedium,
  SiPeerlist,
  SiReddit,
  SiX,
  SiYoutube
} from '@icons-pack/react-simple-icons'
import { Linkedin } from 'lucide-react'
import type { ComponentType } from 'react'
import { siteRoutes } from '@/lib/site'
import { withDubVia } from '../../lib/analytics/dub-via'
import { getRoute } from '../../lib/routing/routes'
import { hasConfiguredPublicSocialLinks, siteConfig } from '../../lib/site/site-config'
import { siteContent } from '../../lib/site/site-content'
import { siteCopy } from '../../lib/site/site-copy'

/**
 * The shell's links, as data the header, mobile menu and footer read (serplists'
 * `publicSiteLinks.ts`, #256). The header stays simple, like serp.co and serplists: one Products
 * menu and two links. A zenbu-style mega-menu waits until there is enough to fill one.
 */

export type SiteLink = {
  href: string
  label: string
}

export type HeaderItem =
  | { kind: 'link'; link: SiteLink }
  | { kind: 'menu'; label: string; links: readonly SiteLink[] }

export type FooterGroup = { title: string; links: readonly SiteLink[] }

export type SocialLink = SiteLink & { icon: ComponentType<{ className?: string }> }

const productLinks: SiteLink[] = [
  { href: getRoute('listing.list'), label: `All ${siteCopy.listingName.plural}` },
  { href: getRoute('category.index'), label: 'Categories' },
  ...(siteConfig.features.showBrands
    ? [{ href: getRoute('brands'), label: siteCopy.brandsLabel }]
    : [])
]

export const headerItems: readonly HeaderItem[] = [
  { kind: 'menu', label: siteCopy.listingName.pluralTitle, links: productLinks },
  { kind: 'link', link: { href: getRoute('pricing'), label: 'Pricing' } },
  { kind: 'link', link: { href: getRoute('about'), label: 'About' } }
]

/** Whether the route registry has the page, so the footer links only pages that exist. */
function hasStaticPagePath(path: string): boolean {
  const normalizedPath = `/${path.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/u, '/')
  return siteRoutes.some(route => route.path === normalizedPath)
}

function directoryLinks(): SiteLink[] {
  return [
    { href: getRoute('submit'), label: siteCopy.submitLabel },
    ...(hasStaticPagePath('/pricing') ? [{ href: getRoute('pricing'), label: 'Pricing' }] : []),
    ...(hasStaticPagePath('/contact') ? [{ href: getRoute('contact'), label: 'Contact' }] : [])
  ]
}

function resourceLinks(): SiteLink[] {
  const { showBrands, showDocs, showGuides, showProjects } = siteConfig.features
  return [
    ...(showProjects ? [{ href: getRoute('projects'), label: siteCopy.networkLabel }] : []),
    ...(showBrands ? [{ href: getRoute('brands'), label: siteCopy.brandsLabel }] : []),
    ...(showDocs ? [{ href: getRoute('docs.list'), label: siteCopy.docsLabel }] : []),
    ...(showGuides || hasStaticPagePath('/posts')
      ? [{ href: getRoute('guides.list'), label: 'Posts' }]
      : []),
    ...(hasStaticPagePath('/sponsor') ? [{ href: getRoute('sponsor'), label: 'Sponsor' }] : [])
  ]
}

function legalLinks(): SiteLink[] {
  return [
    ...(hasStaticPagePath('/legal') ? [{ href: '/legal/', label: 'Legal' }] : []),
    { href: getRoute('about'), label: 'About' },
    { href: getRoute('privacy'), label: 'Privacy Policy' },
    { href: getRoute('terms'), label: 'Terms of Service' },
    { href: getRoute('affiliateDisclosure'), label: 'Affiliate Disclosure' },
    { href: getRoute('dmca'), label: 'DMCA' }
  ]
}

/** The footer's columns; a column with no links is left out. */
export function footerGroups(): FooterGroup[] {
  return [
    { title: 'Directory', links: directoryLinks() },
    { title: 'Resources', links: resourceLinks() },
    { title: 'Legal', links: legalLinks() }
  ].filter(group => group.links.length > 0)
}

function socialIcon(href: string): SocialLink['icon'] | null {
  const normalizedHref = href.toLowerCase()
  if (normalizedHref.includes('linkedin.com') || normalizedHref.includes('/linkedin')) {
    return Linkedin
  }
  if (
    normalizedHref.includes('youtube.com') ||
    normalizedHref.includes('youtu.be') ||
    normalizedHref.includes('/youtube')
  ) {
    return SiYoutube
  }
  if (normalizedHref.includes('facebook.com') || normalizedHref.includes('/facebook')) {
    return SiFacebook
  }
  if (normalizedHref.includes('instagram.com') || normalizedHref.includes('/instagram')) {
    return SiInstagram
  }
  if (normalizedHref.includes('medium.com') || normalizedHref.includes('/medium')) {
    return SiMedium
  }
  if (normalizedHref.includes('sites.google.com') || normalizedHref.includes('/google-sites')) {
    return SiGoogle
  }
  if (normalizedHref.includes('peerlist.io') || normalizedHref.includes('/peerlist')) {
    return SiPeerlist
  }
  return null
}

/** The site's social profiles, once each, from the site config and the network links. */
export function socialLinks(): SocialLink[] {
  const links = new Map<string, SocialLink>()
  if (hasConfiguredPublicSocialLinks(siteConfig)) {
    links.set(siteConfig.githubUrl, { href: siteConfig.githubUrl, icon: SiGithub, label: 'GitHub' })
    links.set(siteConfig.redditUrl, { href: siteConfig.redditUrl, icon: SiReddit, label: 'Reddit' })
    links.set(siteConfig.twitterUrl, {
      href: siteConfig.twitterUrl,
      icon: SiX,
      label: 'X (Twitter)'
    })
  }
  for (const link of siteContent.networkLinks) {
    const icon = socialIcon(link.href)
    if (icon) links.set(link.href, { href: withDubVia(link.href), icon, label: link.label })
  }
  return Array.from(links.values())
}
