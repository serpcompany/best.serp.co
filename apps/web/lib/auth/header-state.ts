import 'server-only'

import type { HeaderAuthState } from '@serpdirectory/web-core/layout/header-auth-state'
import { siteConfig } from '@serpdirectory/web-core/site-config'

/**
 * The header's signed-in state for the root layout. While `showAuth` is off (until the account
 * screens approved in serpcompany/best.serp.co#70 ship) it is constant: it reads no session and
 * does not load Better Auth, which `./server` is imported lazily to keep out of every page.
 */
export async function getHeaderAuthState(): Promise<HeaderAuthState> {
  if (!siteConfig.features.showAuth) return { isAuthenticated: false, isConfigured: false }
  const { getSessionUser } = await import('./server')
  const user = await getSessionUser()
  return user
    ? { isAuthenticated: true, isConfigured: true, user: { image: null, name: user.name || null } }
    : { isAuthenticated: false, isConfigured: true }
}
