import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getRoute } from '../../lib/routing/routes'
import { siteConfig } from '../../lib/site/site-config'
import { resolveFooterBadgeConfigs } from './footer-badges'
import { PageContainer } from './page-shell'
import { footerGroups, legalLinks, socialLinks } from './site-links'

const footerLinkClassName = 'text-sm text-muted-foreground transition-colors hover:text-foreground'

/**
 * The public site's footer (serplists' `SiteFooter`, #256): the site name, tagline and social
 * links, then the link columns, the DR and featured-on badges, and serp.co's bottom row of the
 * copyright and the legal pages.
 */
export function SiteFooter() {
  const badges = resolveFooterBadgeConfigs(siteConfig.domain)
  const socials = socialLinks()
  return (
    <footer className="border-t bg-background">
      <PageContainer width="shell" className="flex flex-col gap-10 py-12">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="flex max-w-sm flex-col gap-4">
            <Link href={getRoute('home')} className="text-sm font-semibold">
              {siteConfig.name}
            </Link>
            <p className="text-sm text-muted-foreground">{siteConfig.tagline}</p>
            {socials.length > 0 ? (
              <ul
                aria-label={`${siteConfig.name} on social media`}
                className="-ml-2 flex flex-wrap gap-1"
              >
                {socials.map(({ href, icon: Icon, label }) => (
                  <li key={href}>
                    <a
                      href={href}
                      aria-label={label}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'icon-lg' }),
                        'text-muted-foreground hover:text-foreground'
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon className="size-5" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            {footerGroups().map(group => (
              <div key={group.title} className="flex flex-col gap-4">
                <h2 className="text-sm font-medium">{group.title}</h2>
                <ul className="flex flex-col gap-3">
                  {group.links.map(link => (
                    <li key={link.href}>
                      <Link href={link.href} className={footerLinkClassName}>
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {badges.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-4 border-t pt-8">
            {badges.map(badge => (
              <li key={badge.href}>
                <a
                  href={badge.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={badge.title}
                  className="inline-flex"
                >
                  <img
                    src={badge.src}
                    alt={badge.alt}
                    width="200"
                    height="50"
                    loading="lazy"
                    decoding="async"
                  />
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-col gap-4 border-t pt-8 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getFullYear()} {siteConfig.name}
          </p>
          <nav aria-label="Legal">
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {legalLinks().map(link => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-foreground hover:underline">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </PageContainer>
    </footer>
  )
}
