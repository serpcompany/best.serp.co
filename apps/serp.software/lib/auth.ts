import type { Session } from 'next-auth'
import { auth } from '@/auth'
import { isStaticExportBuild } from '@/lib/runtime-mode'

export type AuthUserSummary = {
  image: string | null
  name: string | null
}

export type HeaderAuthState = {
  isAuthenticated: boolean
  isConfigured: boolean
  user?: AuthUserSummary
}

const defaultCallbackUrl = '/account'

export function isGitHubAuthConfigured(): boolean {
  if (isStaticExportBuild()) {
    return false
  }

  return Boolean(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.NEXTAUTH_SECRET
  )
}

export function getSafeCallbackUrl(callbackUrl?: string | null): string {
  if (!callbackUrl?.startsWith('/')) {
    return defaultCallbackUrl
  }

  return callbackUrl
}

export async function getSession(): Promise<Session | null> {
  if (!isGitHubAuthConfigured()) {
    return null
  }

  return auth()
}

export async function getHeaderAuthState(): Promise<HeaderAuthState> {
  if (!isGitHubAuthConfigured()) {
    return {
      isAuthenticated: false,
      isConfigured: false
    }
  }

  const session = await getSession()

  if (!session?.user) {
    return {
      isAuthenticated: false,
      isConfigured: true
    }
  }

  return {
    isAuthenticated: true,
    isConfigured: true,
    user: {
      image: session.user.image ?? null,
      name: session.user.name ?? null
    }
  }
}
