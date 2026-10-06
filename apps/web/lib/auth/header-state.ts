import 'server-only'

import type { HeaderAuthState } from '@serpdirectory/web-core/layout/header-auth-state'
import { siteConfig } from '@serpdirectory/web-core/site-config'
import { headers } from 'next/headers'
import { hasSessionCookie } from './cookies'

/**
 * The header's signed-in state for the root layout. Without a Better Auth session cookie the
 * visitor is signed out, so anonymous pages never load Better Auth or read D1; `./server` is
 * imported lazily for the same reason. With `showAuth` off it is constant.
 */
export async function getHeaderAuthState(): Promise<HeaderAuthState> {
  if (!siteConfig.features.showAuth) return { isAuthenticated: false, isConfigured: false }
  const cookieHeader = (await headers()).get('cookie')
  if (!hasSessionCookie(cookieHeader)) return { isAuthenticated: false, isConfigured: true }
  const { getSessionUser } = await import('./server')
  const user = await getSessionUser()
  return user
    ? { isAuthenticated: true, isConfigured: true, user: { image: null, name: user.name || null } }
    : { isAuthenticated: false, isConfigured: true }
}
