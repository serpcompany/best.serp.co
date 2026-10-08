import { Button } from '@serpdirectory/design-system/button'
import { getRoute } from '@serpdirectory/web-core/routes'
import { generateBaseMetadata } from '@serpdirectory/web-core/seo-config'
import { hasConfiguredGitHubIssueTarget, siteConfig } from '@serpdirectory/web-core/site-config'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = generateBaseMetadata({
  title: 'Page Not Found',
  description: `The page you are looking for does not exist. Browse ${siteConfig.name} to explore the directory.`,
  path: '/404',
  noindex: true
})

export default async function NotFound() {
  const issueHref = hasConfiguredGitHubIssueTarget(siteConfig) ? siteConfig.githubIssuesUrl : null

  return (
    <main className="mx-auto relative container flex flex-col items-center justify-center px-4">
      <div className="mx-auto flex h-screen flex-col items-center justify-center">
        <div className="flex h-full flex-col items-center justify-center">
          <span className="not-found rounded-md px-3.5 py-1 text-sm font-medium dark:text-neutral-50">
            404
          </span>
          <h1 className="mt-5 text-3xl font-bold dark:text-neutral-50 md:text-5xl">
            Page Not Found
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-center text-base  text-neutral-400">
            The page you are looking for does not exist. <br />
            {issueHref ? (
              <>
                But don&apos;t worry, we&apos;ve got you covered. You can{' '}
                <Link
                  href={issueHref}
                  className="text-foreground"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  report an issue on GitHub
                </Link>
                .
              </>
            ) : (
              'Try the homepage or one of the starter listings instead.'
            )}
          </p>
          <Button asChild className="mt-8">
            <Link href={getRoute('home')}>Back to homepage</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
