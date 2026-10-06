import { expect, type Page, test } from '@playwright/test'

/**
 * The #95 acceptance check, run by hand against a deployed Worker after its catalog was
 * migrated (docs/MEDIA.md): no page, `og:image`, or JSON-LD names a listing image outside the
 * environment's media host or the fallback tile, and every listing image there answers 200.
 *
 *   MEDIA_ACCEPTANCE=1 PLAYWRIGHT_BASE_URL=https://best-serp-co-staging.serpcompany.workers.dev \
 *     PLAYWRIGHT_EXTERNAL_SERVER=1 pnpm --filter e2e exec playwright test \
 *     tests/listing-media-acceptance.spec.ts --project=chromium
 *
 * The media host follows the base URL (`MEDIA_HOST` overrides it). It never runs in CI or
 * locally, where the catalog is the unmigrated import.
 */
const enabled = process.env.MEDIA_ACCEPTANCE === '1' && Boolean(process.env.PLAYWRIGHT_BASE_URL)
const fallbackTile = '/listing-logos/favicon-fallback-512x512.png'
const listingSample = Number(process.env.MEDIA_ACCEPTANCE_LISTINGS ?? 40)

test.skip(!enabled, 'Set MEDIA_ACCEPTANCE=1 and PLAYWRIGHT_BASE_URL to a migrated environment.')

function mediaHost(baseURL: string): string {
  if (process.env.MEDIA_HOST) return process.env.MEDIA_HOST
  const host = new URL(baseURL).host
  return host === 'best.serp.co' || host.startsWith('best-serp-co-production.')
    ? 'cdn.serp.co'
    : 'cdn-staging.serp.co'
}

/** Listing images on a page: logos, featured images, and the JSON-LD primary image. */
async function listingImageUrls(page: Page): Promise<string[]> {
  const fromMarkup = await page
    .locator('img[alt$=" logo"], img[alt$=" featured image"], img[alt$=" fallback logo"]')
    .evaluateAll(images =>
      images.map(image => (image as HTMLImageElement).currentSrc || image.getAttribute('src') || '')
    )
  const fromJsonLd = await page.locator('script[type="application/ld+json"]').evaluateAll(scripts =>
    scripts.flatMap(script => {
      const urls: string[] = []
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') {
          for (const [key, entry] of Object.entries(value)) {
            if (key === 'primaryImageOfPage' && entry && typeof entry === 'object') {
              const url = (entry as { url?: unknown }).url
              if (typeof url === 'string') urls.push(url)
            } else visit(entry)
          }
        }
      }
      visit(JSON.parse(script.textContent ?? 'null'))
      return urls
    })
  )
  return [...fromMarkup, ...fromJsonLd].filter(Boolean)
}

test('listing images come only from the media host and load', async ({
  baseURL,
  page,
  request
}) => {
  test.setTimeout(10 * 60_000)
  const origin = baseURL ?? ''
  const host = mediaHost(origin)
  const sitemap = await (await request.get(`${origin}/sitemaps/directory/1.xml`)).text()
  const listingPaths = [...sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/products\/[^<]+)<\/loc>/gu)]
    .map(match => match[1] ?? '')
    .filter(path => !path.includes('/categories/'))
  const step = Math.max(1, Math.floor(listingPaths.length / listingSample))
  const paths = ['/', '/products/', ...listingPaths.filter((_, index) => index % step === 0)]
  const offHost: string[] = []
  const checked = new Map<string, number>()
  for (const path of paths) {
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' })
    for (const url of await listingImageUrls(page)) {
      const resolved = new URL(url, origin)
      if (resolved.pathname === fallbackTile) continue
      if (resolved.host !== host) offHost.push(`${path}: ${url}`)
      else if (!checked.has(resolved.href)) {
        checked.set(resolved.href, (await request.head(resolved.href)).status())
      }
    }
  }
  test.info().annotations.push({
    type: 'media checked',
    description: `${checked.size} hosted images on ${paths.length} pages (${host})`
  })
  expect(offHost, `listing images outside ${host}`).toEqual([])
  expect([...checked].filter(([, status]) => status !== 200)).toEqual([])
})
