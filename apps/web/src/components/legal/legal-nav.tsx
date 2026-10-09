import Link from 'next/link'
import { SITE_NAME } from '@/lib/seo/seo-config'
import { type LegalPagePath, legalPageFor, legalPages } from '@/lib/site/legal-pages'
import { cn } from '@/lib/utils'

const items = [{ path: '/legal/', title: 'Overview' }, ...legalPages]

/** A legal page's description, with the site's name in place. */
export function legalDescription(description: string): string {
  return description.replace(/\{\{SITE_NAME\}\}/gu, SITE_NAME)
}

/**
 * Sidebar of the legal pages, marking the current one (serp.co's `legal-nav.tsx`, #276). Pills
 * on phones, a rail on desktops.
 */
export function LegalNav({ current }: { current: string }) {
  return (
    <nav aria-label="Legal pages">
      <p className="mb-3 font-mono text-xs text-muted-foreground uppercase">Legal</p>
      <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-0 lg:border-l lg:border-border">
        {items.map(item => {
          const active = item.path === current
          return (
            <li key={item.path}>
              <Link
                href={item.path}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground',
                  'lg:-ml-px lg:rounded-none lg:border-0 lg:border-l-2 lg:border-transparent lg:py-2 lg:pl-4 lg:hover:border-foreground/30',
                  active &&
                    'border-foreground/60 text-foreground lg:border-foreground lg:font-medium'
                )}
              >
                {item.title}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** Shared `PageShell` props for a page under /legal/: docs layout, breadcrumbs, and sidebar. */
export function legalShell(path: LegalPagePath) {
  const page = legalPageFor(path)
  return {
    title: page.title,
    description: <p>{legalDescription(page.description)}</p>,
    layout: 'docs' as const,
    breadcrumbs: [
      { name: 'Home', path: '/' },
      { name: 'Legal', path: '/legal/' },
      { name: page.title, path: page.path }
    ],
    aside: <LegalNav current={path} />
  }
}
