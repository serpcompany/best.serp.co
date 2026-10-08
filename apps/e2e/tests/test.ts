import { type BrowserContext, test as base, type Page } from '@playwright/test'

/**
 * Always allowed: images the committed D1 import still points at legacy media hosts that no
 * longer serve them. Local and CI runs load that import; production's listing media is migrated
 * and checked by `pnpm media:health`, so a miss here is data, not a code error. The fallback
 * tile is the site's own asset, so a miss on it is never allowed.
 */
const catalogMediaMiss =
  /Failed to load resource: the server responded with a status of 404 \(Not Found\) \((?!.*favicon-fallback-512x512\.png)(?:http:\/\/127\.0\.0\.1:\d+\/listing-logos\/|https:\/\/imagedelivery\.net\/|https:\/\/raw\.githubusercontent\.com\/serpapps\/)/u

/** Allows the browser's "Failed to load resource" for a response a spec expects on purpose. */
export function expectedResponse(status: number, path: RegExp): RegExp {
  return new RegExp(
    `Failed to load resource: the server responded with a status of ${status} .*\\(http://127\\.0\\.0\\.1:\\d+${path.source}`,
    'u'
  )
}

/** Errors a spec triggers on purpose, and why. (An object: Playwright reads arrays as tuples.) */
export type AllowedConsoleErrors = { because: string; patterns: RegExp[] }

type ConsoleFixtures = {
  allowedConsoleErrors: AllowedConsoleErrors
  failOnConsoleErrors: undefined
}

/**
 * The `test` every journey imports (#160). It fails a test on any browser console error or
 * uncaught page error, as SERP's repository-layout standard requires ("A console error fails the
 * test"), so hydration mismatches and broken client code can't pass silently.
 *
 * It watches every page the test opens: pages of the default context, and pages of contexts the
 * test creates itself with `browser.newContext()` or `browser.newPage()`. Pages opened in
 * `beforeAll` and `afterAll` hooks are not watched, because those hooks run outside a test. A spec that triggers an error on purpose
 * allows it with `test.use({ allowedConsoleErrors: { because, patterns } })`.
 */
export const test = base.extend<ConsoleFixtures>({
  allowedConsoleErrors: [{ because: '', patterns: [] }, { option: true }],
  failOnConsoleErrors: [
    async ({ allowedConsoleErrors, browser, context }, use) => {
      const errors: string[] = []
      const record = (entry: string) => {
        const allowed = [catalogMediaMiss, ...allowedConsoleErrors.patterns]
        if (!allowed.some(pattern => pattern.test(entry))) errors.push(entry)
      }
      const watchPage = (page: Page) => {
        page.on('console', message => {
          if (message.type() !== 'error') return
          record(`console.error on ${page.url()}: ${message.text()} (${message.location().url})`)
        })
        page.on('pageerror', error => record(`uncaught error on ${page.url()}: ${error.message}`))
      }
      const watchContext = (watched: BrowserContext) => {
        for (const page of watched.pages()) watchPage(page)
        watched.on('page', watchPage)
      }

      watchContext(context)
      // Contexts a spec creates itself: wrap newContext for this test only, then restore it.
      const newContext = browser.newContext
      browser.newContext = async (...args) => {
        const created = await newContext.apply(browser, args)
        watchContext(created)
        return created
      }
      try {
        await use(undefined)
      } finally {
        browser.newContext = newContext
      }

      if (errors.length > 0) {
        throw new Error(`Browser console errors (${errors.length}):\n- ${errors.join('\n- ')}`)
      }
    },
    { auto: true }
  ]
})
