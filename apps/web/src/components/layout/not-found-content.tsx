import type { Metadata } from 'next'
import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { getRoute } from '@/lib/routing/routes'
import { generateBaseMetadata } from '@/lib/seo/seo-config'
import { hasConfiguredGitHubIssueTarget, siteConfig } from '@/lib/site/site-config'

export const notFoundMetadata: Metadata = generateBaseMetadata({
  title: 'Page Not Found',
  description: `The page you are looking for does not exist. Browse ${siteConfig.name} to explore the directory.`,
  path: '/404',
  noindex: true
})

/** The 404 page's content; `app/not-found.tsx` and `app/(dashboard)/not-found.tsx` place it. */
export function NotFoundContent() {
  const issueHref = hasConfiguredGitHubIssueTarget(siteConfig) ? siteConfig.githubIssuesUrl : null

  return (
    <div className="mx-auto relative container flex flex-col items-center justify-center px-4">
      <div className="mx-auto flex h-screen flex-col items-center justify-center">
        <div className="flex h-full flex-col items-center justify-center">
          <span className="not-found rounded-md px-3.5 py-1 text-sm font-medium">404</span>
          <h1 className="mt-5 text-3xl font-bold md:text-5xl">Page Not Found</h1>
          <p className="mx-auto mt-5 max-w-xl text-center text-base text-muted-foreground">
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
          <Link href={getRoute('home')} className={buttonVariants({ className: 'mt-8' })}>
            Back to homepage
          </Link>
        </div>
      </div>
    </div>
  )
}
