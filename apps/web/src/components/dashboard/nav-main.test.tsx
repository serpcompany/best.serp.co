import { FileText, Inbox, LayoutDashboard } from 'lucide-react'
import type React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarProvider } from '@/components/ui/sidebar'
import { SidebarAccountMenu, userInitial } from './account-menu'
import { AppShell } from './app-shell'
import { DashboardHeader } from './dashboard-header'
import { isNavItemActive, NavMain } from './nav-main'
import { SidebarBrand } from './sidebar-brand'

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

  it('renders serplists’ full-size rows, the quick action first in the same group', () => {
    const html = render(
      <NavMain
        items={[...ACCOUNT_NAV, { badge: 3, href: '/account/listings/', title: 'Listings' }]}
        quickAction={{ href: '/submit/', title: 'Submit a product' }}
      />
    )
    expect(html.match(/data-slot="sidebar-group"/gu)).toHaveLength(1)
    expect(html).not.toContain('data-sidebar="group-label"')
    expect(html.indexOf('Submit a product')).toBeLessThan(html.indexOf('Overview'))
    for (const title of ['Submit a product', 'Overview', 'Submissions', 'Listings']) {
      expect(menuButton(html, title)).toMatch(/class="[^"]*\bh-11\b/u)
    }
    expect(menuButton(html, 'Submit a product')).toContain('bg-primary text-primary-foreground')
    // The count badge is centred on the 44px row.
    expect(html).toMatch(
      /data-sidebar="menu-badge" class="[^"]*peer-data-\[size=default\]\/menu-button:top-3/u
    )
    expect(html).not.toContain('peer-data-[size=default]/menu-button:top-1.5')
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

describe('DashboardHeader', () => {
  it('links parent crumbs, hides them below md, and marks the current page', () => {
    const html = render(
      <DashboardHeader crumbs={[{ href: '/account/', label: 'Account' }, { label: 'Overview' }]} />
    )
    expect(html).toMatch(
      /<li[^>]*class="[^"]*hidden md:block[^"]*"[^>]*><a[^>]*href="\/account\/?"/u
    )
    expect(html).toMatch(/aria-current="page"[^>]*>Overview</u)
  })

  it('is serplists’ sticky top bar, with the sidebar trigger first', () => {
    const html = render(
      <DashboardHeader crumbs={[{ label: 'Overview' }]} actions={<a href="/">View</a>} />
    )
    expect(html).toMatch(/^<div[^>]*><header class="sticky top-0 z-40 flex h-14 shrink-0/u)
    expect(html.indexOf('data-sidebar="trigger"')).toBeLessThan(html.indexOf('Overview'))
    // The breadcrumb's separator is centred in the taller bar, not stretched to its top.
    expect(html).toMatch(/data-slot="separator"[^>]*class="[^"]*data-vertical:self-center/u)
    expect(html).toMatch(/class="ml-auto flex items-center gap-2"><a href="\/">View<\/a>/u)
  })
})

const USER = { email: 'maya@quillmate.app', name: 'Maya Ortiz' }

function accountMenu(user = USER) {
  return (
    <SidebarAccountMenu
      user={user}
      links={[{ href: '/', title: 'View best.serp.co' }]}
      onSignOut={() => undefined}
    />
  )
}

describe('AppShell', () => {
  it('renders the account configuration: a white inset card, inert while collapsed off-canvas', () => {
    const expanded = renderToStaticMarkup(
      <AppShell
        accountMenu={accountMenu()}
        header={<header />}
        sidebarContent={<NavMain items={ACCOUNT_NAV} />}
      >
        <p>content</p>
      </AppShell>
    )
    expect(expanded).toContain('data-variant="inset"')
    expect(expanded).toMatch(/data-slot="sidebar-inset" class="[^"]*bg-card/u)
    expect(expanded).not.toContain('inert=""')

    const collapsed = renderToStaticMarkup(
      <AppShell
        accountMenu={accountMenu()}
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
        accountMenu={accountMenu()}
        collapsible="icon"
        defaultOpen={false}
        rail
        variant="sidebar"
        sidebarHeader={<SidebarBrand href="/admin/" title="SERP" subtitle="Admin" />}
        sidebarContent={
          <NavMain
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
    expect(menuButton(html, 'Review queue')).toContain('data-base-ui-tooltip-trigger=""')
    expect(html).toMatch(
      /data-sidebar="menu-badge" class="[^"]*group-data-\[collapsible=icon\]:hidden/u
    )
    // Only the inset variant paints the white card.
    expect(html).not.toMatch(/data-slot="sidebar-inset" class="[^"]*bg-card/u)
  })

  it('wraps the rows in the Dashboard navigation and ends with the theme row and account menu', () => {
    const html = renderToStaticMarkup(
      <AppShell
        accountMenu={accountMenu()}
        header={<header />}
        sidebarContent={<NavMain items={ACCOUNT_NAV} />}
      >
        <p>content</p>
      </AppShell>
    )
    expect(html).toMatch(
      /data-sidebar="content"[^>]*><nav aria-label="Dashboard" class="flex min-h-0 flex-1 flex-col">/u
    )
    const footer = html.slice(html.indexOf('data-sidebar="footer"'))
    // The server renders light, so the row offers dark mode (serplists’ labels).
    expect(footer).toMatch(/<button[^>]*aria-label="Switch to dark mode"[^>]*class="[^"]*\bh-11\b/u)
    expect(footer).toContain('<span>Light mode</span>')
    expect(footer.indexOf('Light mode')).toBeLessThan(footer.indexOf('aria-label="Account menu"'))
  })
})

describe('SidebarAccountMenu', () => {
  it('is serplists’ footer trigger: the initial, the name over the address, and the chevrons', () => {
    const html = render(accountMenu())
    expect(html).toMatch(
      /aria-label="Account menu"[^>]*data-size="lg"|data-size="lg"[^>]*aria-label="Account menu"/u
    )
    expect(html).toContain('data-size="sm"')
    expect(html).toContain('>M</span>')
    expect(html).toMatch(
      />Maya Ortiz<\/span><span class="[^"]*text-muted-foreground">maya@quillmate\.app</u
    )
    expect(html).toContain('lucide-chevrons-up-down')
  })

  it('shows the address alone for a user without a name', () => {
    const html = render(accountMenu({ email: 'jordan@brieflow.ai', name: '  ' }))
    expect(html).toContain('>J</span>')
    expect(html.match(/jordan@brieflow\.ai/gu)).toHaveLength(1)
  })
})

describe('userInitial', () => {
  it('takes the first letter of the name, else of the address', () => {
    expect(userInitial({ email: 'maya@quillmate.app', name: 'maya Ortiz' })).toBe('M')
    expect(userInitial({ email: 'jordan@brieflow.ai', name: '  ' })).toBe('J')
  })
})
