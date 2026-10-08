import { generateBaseMetadata } from '@/lib/seo/seo-config'
import type { Metadata } from 'next'
import type { ReactElement } from 'react'
import { LoginCard } from '@/components/auth/login-card'
import { safeCallbackPath } from '@/lib/auth/callback-url'
import { getSessionUser } from '@/lib/auth/server'
import { requireRouteFeature } from '@/lib/route-feature-gates'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Sign up or sign in',
  description: 'Sign up or sign in to SERP with a 6-digit code sent to your email.',
  path: '/login/',
  noindex: true
})

type LoginPageProps = {
  searchParams: Promise<{ callbackUrl?: string | string[] }>
}

/** `/login` (serpcompany/best.serp.co#60): email-code sign-in; never cached or indexed. */
export default async function LoginPage({ searchParams }: LoginPageProps): Promise<ReactElement> {
  requireRouteFeature('showAuth')
  const callbackPath = safeCallbackPath((await searchParams).callbackUrl)
  const user = await getSessionUser()
  return <LoginCard callbackPath={callbackPath} signedInEmail={user?.email ?? null} />
}
