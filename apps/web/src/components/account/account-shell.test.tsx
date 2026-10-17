import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AccountShell } from './account-shell'

vi.mock('next/navigation', () => ({ usePathname: () => '/account/' }))

const USER = { email: 'devin@serp.co', name: 'Devin' }

function sidebar(reviewQueueCount?: number): string {
  return renderToStaticMarkup(
    <AccountShell reviewQueueCount={reviewQueueCount} user={USER}>
      <p>Overview</p>
    </AccountShell>
  )
}

/** The menu item (`<li>`) whose text includes `title`. */
function menuItem(html: string, title: string): string {
  const items = html.match(/<li [^>]*data-sidebar="menu-item"[^>]*>.*?<\/li>/gu) ?? []
  return items.find(item => item.includes(`>${title}<`)) ?? ''
}

describe('account sidebar review queue entry (#489)', () => {
  it('shows admins "Review queue" last, linking to the admin queue with its waiting count', () => {
    const html = sidebar(4)
    const item = menuItem(html, 'Review queue')
    expect(item).toMatch(/href="\/admin\/submissions\/?"/u)
    expect(item).toMatch(/data-sidebar="menu-badge"[^>]*>4<\/div>/u)
    expect(html.indexOf('Review queue')).toBeGreaterThan(html.indexOf('Settings'))
  })

  it('hides the badge when nothing is waiting', () => {
    const item = menuItem(sidebar(0), 'Review queue')
    expect(item).toMatch(/href="\/admin\/submissions\/?"/u)
    expect(item).not.toContain('data-sidebar="menu-badge"')
  })

  it('shows everyone else no entry and no admin link', () => {
    const html = sidebar()
    expect(html).not.toContain('Review queue')
    expect(html).not.toContain('/admin')
  })
})
