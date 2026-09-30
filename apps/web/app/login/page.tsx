import { Button } from '@serpdirectory/design-system/button'
import { getRoute } from '@serpdirectory/web-core/routes'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactElement } from 'react'
import { GitHubSignInButton } from '@/components/auth/github-sign-in-button'
import { getSafeCallbackUrl, getSession, isGitHubAuthConfigured } from '@/lib/auth'
import { requireRouteFeature } from '@/lib/route-feature-gates'
import { isStaticExportBuild } from '@/lib/runtime-mode'

type LoginPageProps = {
  searchParams: Promise<{
    callbackUrl?: string
  }>
}

export default async function LoginPage({ searchParams }: LoginPageProps): Promise<ReactElement> {
  requireRouteFeature('showAuth')

  const isStaticBuild = isStaticExportBuild()
  const callbackUrl = isStaticBuild
    ? getSafeCallbackUrl()
    : getSafeCallbackUrl((await searchParams).callbackUrl)
  const session = await getSession()

  if (!isStaticBuild && session?.user) {
    redirect(callbackUrl)
  }

  const isConfigured = isGitHubAuthConfigured()

  return (
    <section className="container mx-auto flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-none border border-border bg-card p-8 shadow-sm">
        <div className="space-y-3">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            GitHub Access
          </p>
          <h1 className="text-3xl font-bold tracking-tight">Sign up / Sign in</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {isStaticBuild
              ? 'GitHub auth is disabled for the static Pages build used by this demo.'
              : 'Use GitHub to create an account or sign back in. No local password storage is needed for this starter.'}
          </p>
        </div>

        <div className="mt-8 space-y-4">
          <GitHubSignInButton callbackUrl={callbackUrl} disabled={!isConfigured} />
          {!isConfigured ? (
            <p className="text-sm text-muted-foreground">
              Add `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `NEXTAUTH_SECRET` to enable GitHub
              auth.
            </p>
          ) : null}
        </div>

        <div className="mt-8 border-t border-border pt-6">
          <Button asChild variant="ghost" className="w-full rounded-none font-bold">
            <Link href={getRoute('home')}>Back to home</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
