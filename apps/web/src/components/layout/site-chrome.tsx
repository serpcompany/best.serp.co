import type { ReactNode } from 'react'
import { getHeaderAuthState } from '@/lib/auth/header-state'
import { SiteFooter } from './site-footer'
import { SiteHeader } from './site-header'

/**
 * The public site's header, footer, and the page's one `<main>`: the `(site)` layout and the
 * root 404 page render it. The dashboards (`(dashboard)`) have their own shells instead.
 */
export async function SiteChrome({ children }: { children: ReactNode }) {
  const authState = await getHeaderAuthState()
  return (
    <div data-site-chrome="" className="flex min-h-screen flex-col">
      <SiteHeader authState={authState} />
      <main className="flex flex-1 flex-col">{children}</main>
      <SiteFooter />
    </div>
  )
}
