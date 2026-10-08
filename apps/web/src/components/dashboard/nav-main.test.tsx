import { FileText, Inbox, LayoutDashboard } from 'lucide-react'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppShell } from './app-shell'
import { isNavItemActive, NavMain } from './nav-main'
import { initials } from './nav-user'
import { SidebarBrand } from './sidebar-brand'
import { SiteHeader } from './site-header'

const navigation = vi.hoisted(() => ({ pathname: '/account/' as string | null }))
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }))

afterEach(() => {
  navigation.pathname = '/account/'
})

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<SidebarProvider>{node}</SidebarProvider>)
}

const ACCOUNT_NAV = [
  { exact: true, href: '/account/', icon: LayoutDashboard, title: 'Overview' },
  { href: '/account/submissions/', icon: FileText, title: 'Submissions' }
]

/** The `<a>` (or `<span>`) of the menu button whose text is `title`. */
function menuButton(html: string, title: string): string {
  const match = html.match(
    new RegExp(`<(a|span) [^>]*data-sidebar="menu-button"[^>]*>(?:(?!</\\1>).)*?${title}`, 'u')
  )
  return match?.[0] ?? ''
}

describe('dashboard NavMain', () => {
  it('links built sections and marks the current page from the path', () => {
    const html = render(<NavMain items={ACCOUNT_NAV} />)
    // next/link drops the trailing slash outside the app's router config.
    expect(html).toMatch(/href="\/account\/?"/u)
    expect(menuButton(html, 'Overview')).toContain('aria-current="page"')
    expect(menuButton(html, 'Submissions')).not.toContain('aria-current')
  })

  it('moves the current page to a nested section instead of keeping Overview active', () => {
    navigation.pathname = '/account/submissions/s_4f9k2c/'
    const html = render(<NavMain items={ACCOUNT_NAV} />)
    expect(menuButton(html, 'Overview')).not.toContain('aria-current')
    expect(menuButton(html, 'Submissions')).toContain('aria-current="page"')
  })

  it('shows unbuilt sections with a Soon badge instead of a disabled-looking item', () => {
    const html = render(<NavMain items={[{ icon: FileText, title: 'Submissions' }]} />)
    expect(html).toContain('Submissions')
    expect(html).toContain('(coming soon)')
    expect(html).toContain('>Soon</div>')
    expect(html).not.toContain('aria-disabled="')
    expect(html).not.toContain('href=')
  })
})

describe('isNavItemActive', () => {
  it('matches the exact path, trailing slash or not', () => {
    expect(isNavItemActive('/account/', '/account/', true)).toBe(true)
    expect(isNavItemActive('/account', '/account/', true)).toBe(true)
    expect(isNavItemActive('/account/listings/', '/account/', true)).toBe(false)
  })

  it('matches sub-paths unless exact, and never by a shared prefix alone', () => {
    expect(isNavItemActive('/admin/listings/brieflow.ai/', '/admin/listings/')).toBe(true)
    expect(isNavItemActive('/admin/listings-archive/', '/admin/listings/')).toBe(false)
    expect(isNavItemActive(null, '/admin/')).toBe(false)
  })
})

describe('dashboard SiteHeader', () => {
  it('links parent crumbs, hides them below md, and marks the current page', () => {
    const html = render(
      <SiteHeader crumbs={[{ href: '/account/', label: 'Account' }, { label: 'Overview' }]} />
    )
    expect(html).toMatch(
      /<li[^>]*class="[^"]*hidden md:block[^"]*"[^>]*><a[^>]*href="\/account\/?"/u
    )
    expect(html).toMatch(/aria-current="page"[^>]*>Overview</u)
  })
})

describe('AppShell', () => {
  it('renders the account configuration: a white inset card, inert while collapsed off-canvas', () => {
    const expanded = renderToStaticMarkup(
      <AppShell header={<header />} sidebarContent={<NavMain items={ACCOUNT_NAV} />}>
        <p>content</p>
      </AppShell>
    )
    expect(expanded).toContain('data-variant="inset"')
    expect(expanded).toMatch(/data-slot="sidebar-inset" class="[^"]*bg-card/u)
    expect(expanded).not.toContain('inert=""')

    const collapsed = renderToStaticMarkup(
      <AppShell
        defaultOpen={false}
        header={<header />}
        sidebarContent={<NavMain items={ACCOUNT_NAV} />}
      >
        <p>content</p>
      </AppShell>
    )
    expect(collapsed).toContain('data-collapsible="offcanvas"')
    expect(collapsed).toMatch(/data-slot="sidebar-panel" inert=""/u)
  })

  it('renders the admin configuration: icon collapse, rail and branded header (sidebar-07)', () => {
    const html = renderToStaticMarkup(
      <AppShell
        collapsible="icon"
        defaultOpen={false}
        rail
        variant="sidebar"
        sidebarHeader={<SidebarBrand href="/admin/" title="SERP" subtitle="Admin" />}
        sidebarContent={
          <NavMain
            label="Admin"
            items={[{ badge: 6, href: '/admin/submissions/', icon: Inbox, title: 'Review queue' }]}
          />
        }
        header={<header />}
      >
        <p>content</p>
      </AppShell>
    )
    // The collapsed sidebar stays as icons, so it is not inert, and the rail is there.
    expect(html).toContain('data-collapsible="icon"')
    expect(html).toContain('data-variant="sidebar"')
    expect(html).toContain('data-sidebar="rail"')
    expect(html).not.toContain('inert=""')
    // sidebar-07's logo tile with the area name.
    expect(html).toContain('>Admin</span>')
    expect(html).toContain('bg-primary text-primary-foreground')
    // Menu buttons carry their icon-mode tooltip trigger; the count badge hides in icon mode.
    expect(menuButton(html, 'Review queue')).toContain('data-state="closed"')
    expect(html).toMatch(
      /data-sidebar="menu-badge" class="[^"]*group-data-\[collapsible=icon\]:hidden/u
    )
    // Only the inset variant paints the white card.
    expect(html).not.toMatch(/data-slot="sidebar-inset" class="[^"]*bg-card/u)
  })
})

describe('dashboard initials', () => {
  it('takes two letters from the name, else from the address', () => {
    expect(initials({ email: 'maya@quillmate.app', name: 'Maya Ortiz' })).toBe('MO')
    expect(initials({ email: 'maya@quillmate.app', name: 'Maya' })).toBe('MA')
    expect(initials({ email: 'jordan@brieflow.ai', name: '  ' })).toBe('JO')
  })
})
