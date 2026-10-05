import { SidebarProvider } from '@serpdirectory/design-system/sidebar'
import { FileText, LayoutDashboard } from 'lucide-react'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NavMain } from './nav-main'
import { initials } from './nav-user'
import { SiteHeader } from './site-header'

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<SidebarProvider>{node}</SidebarProvider>)
}

describe('dashboard NavMain', () => {
  it('links built sections and marks the active one', () => {
    const html = render(
      <NavMain
        items={[{ href: '/account/', icon: LayoutDashboard, isActive: true, title: 'Overview' }]}
      />
    )
    // next/link drops the trailing slash outside the app's router config.
    expect(html).toMatch(/href="\/account\/?"/u)
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('data-active="true"')
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

describe('dashboard initials', () => {
  it('takes two letters from the name, else from the address', () => {
    expect(initials({ email: 'maya@quillmate.app', name: 'Maya Ortiz' })).toBe('MO')
    expect(initials({ email: 'maya@quillmate.app', name: 'Maya' })).toBe('MA')
    expect(initials({ email: 'jordan@brieflow.ai', name: '  ' })).toBe('JO')
  })
})
