import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { detailListing, sampleCategory, sampleListing, searchSample } from './listing-fixture'
import { seedListings } from './seed-facts'
import { categoriesIndexPath, categoryPath, site } from './site-fixture'
import { test } from './test'

/** The checked-in "no logo" tile (serpcompany/best.serp.co#86). */
const fallbackLogoPath = '/listing-logos/favicon-fallback-512x512.png'
/** The seed's published listing with no logo in D1. */
const logoLessListing = sampleListing(seedListings.noLogo)

/**
 * Pages a visitor reaches first, plus a listing with a hosted logo and featured image (the seed
 * hosts them through the real ingestion path, served at `/_media`) and one without a logo.
 */
const samplePages = [
  '/',
  '/products/',
  categoriesIndexPath,
  categoryPath(sampleCategory.slug),
  '/about/',
  `/search/?q=${searchSample.query}`,
  detailListing.path,
  logoLessListing.path
]

const fileUrlPattern =
  /\.(?:avif|css|gif|ico|jpe?g|js|json|png|svg|txt|webmanifest|webp|woff2?|xml)$/iu
const structuredDataAssetKeys = new Set(['contentUrl', 'image', 'logo', 'thumbnailUrl', 'url'])
const checkedResourceTypes = new Set(['font', 'image', 'script', 'stylesheet'])

async function structuredData(page: Page): Promise<unknown[]> {
  return page
    .locator('script[type="application/ld+json"]')
    .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
}

/** String values under image-like keys that name a file, at any depth. */
function structuredDataAssetUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(structuredDataAssetUrls)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === 'string'
      ? structuredDataAssetKeys.has(key) &&
        fileUrlPattern.test(new URL(entry, site.publicUrl).pathname)
        ? [entry]
        : []
      : structuredDataAssetUrls(entry)
  )
}

/** Every same-origin file the rendered DOM points at: images, icons, styles, scripts, meta images. */
async function domAssetUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const urls: string[] = []
    const add = (value: string | null | undefined) => {
      if (value) urls.push(value)
    }
    for (const image of document.querySelectorAll('img')) add(image.getAttribute('src'))
    for (const element of document.querySelectorAll('img[srcset], source[srcset]')) {
      for (const candidate of (element.getAttribute('srcset') ?? '').split(',')) {
        add(candidate.trim().split(/\s+/u)[0])
      }
    }
    for (const link of document.querySelectorAll('link[href]')) {
      const rel = link.getAttribute('rel') ?? ''
      if (/icon|manifest|stylesheet|preload/u.test(rel)) add(link.getAttribute('href'))
    }
    for (const script of document.querySelectorAll('script[src]')) add(script.getAttribute('src'))
    for (const meta of document.querySelectorAll(
      'meta[property="og:image"], meta[name="twitter:image"]'
    )) {
      add(meta.getAttribute('content'))
    }
    return urls
  })
}

/**
 * The local path for a URL served by this Worker: same-origin and best.serp.co URLs map to
 * the server under test; other hosts (remote listing logos) are out of scope.
 */
function localPath(url: string, baseURL: string): string | undefined {
  const resolved = new URL(url, baseURL)
  const servedHosts = new Set([new URL(baseURL).host, new URL(site.publicUrl).host])
  if (!servedHosts.has(resolved.host) || resolved.protocol === 'data:') return undefined
  return `${resolved.pathname}${resolved.search}`
}

async function expectServed(request: APIRequestContext, path: string, referrer: string) {
  const response = await request.get(path, { maxRedirects: 0 })
  expect(response.status(), `${path} (referenced by ${referrer})`).toBe(200)
}

function webPageNode(data: unknown[]): Record<string, unknown> {
  const nodes = data.flatMap(entry =>
    entry && typeof entry === 'object' && '@graph' in entry
      ? ((entry as { '@graph': Record<string, unknown>[] })['@graph'] ?? [])
      : [entry as Record<string, unknown>]
  )
  const node = nodes.find(entry => entry?.['@type'] === 'WebPage')
  expect(node, 'listing JSON-LD has a WebPage node').toBeTruthy()
  return node as Record<string, unknown>
}

test.describe('listing logo assets', () => {
  test('the Worker serves the no-logo fallback tile as a 512px PNG', async ({ request }) => {
    const response = await request.get(fallbackLogoPath, { maxRedirects: 0 })

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('image/png')
    const body = await response.body()
    expect(body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(body.readUInt32BE(16)).toBe(512)
    expect(body.readUInt32BE(20)).toBe(512)
  })

  test('a listing without a logo shows the fallback tile and no JSON-LD image', async ({
    page
  }) => {
    const response = await page.goto(logoLessListing.path, { waitUntil: 'networkidle' })
    expect(response?.status()).toBe(200)

    const heroLogo = page
      .getByRole('img', { name: `${logoLessListing.name} fallback logo` })
      .first()
    await expect(heroLogo).toBeVisible()
    await expect(heroLogo).toHaveAttribute('src', fallbackLogoPath)
    await expect
      .poll(() => heroLogo.evaluate(image => (image as HTMLImageElement).naturalWidth))
      .toBe(512)

    const data = await structuredData(page)
    expect(webPageNode(data)).not.toHaveProperty('primaryImageOfPage')
    expect(JSON.stringify(data)).not.toContain(fallbackLogoPath)
  })

  test('a listing with a logo names that logo as the JSON-LD primary image', async ({ page }) => {
    await page.goto(detailListing.path, { waitUntil: 'domcontentloaded' })
    const heroLogo = page
      .getByRole('main')
      .getByRole('img', { name: / logo$/u })
      .first()
    const logoSrc = await heroLogo.getAttribute('src')
    expect(logoSrc, `${detailListing.path} hero logo`).toBeTruthy()
    expect(logoSrc).not.toBe(fallbackLogoPath)

    const primaryImage = webPageNode(await structuredData(page)).primaryImageOfPage
    expect(primaryImage, detailListing.path).toEqual({
      '@type': 'ImageObject',
      url: new URL(logoSrc ?? '', site.publicUrl).href
    })
  })

  test('sample pages reference no missing same-origin asset, in markup or JSON-LD', async ({
    baseURL,
    page,
    request
  }) => {
    test.setTimeout(120_000)
    expect(baseURL).toBeTruthy()
    const origin = baseURL ?? ''
    const referenced = new Map<string, string>()
    const failedLoads: string[] = []

    page.on('response', response => {
      const path = localPath(response.url(), origin)
      if (
        path &&
        response.status() >= 400 &&
        checkedResourceTypes.has(response.request().resourceType())
      ) {
        failedLoads.push(`${response.status()} ${path} (loaded by ${page.url()})`)
      }
    })

    for (const pagePath of samplePages) {
      const response = await page.goto(pagePath, { waitUntil: 'networkidle' })
      expect(response?.status(), pagePath).toBe(200)

      const urls = [
        ...(await domAssetUrls(page)),
        ...structuredDataAssetUrls(await structuredData(page))
      ]
      for (const url of urls) {
        const path = localPath(url, origin)
        if (path && !referenced.has(path)) referenced.set(path, pagePath)
      }
    }

    expect(referenced.has(fallbackLogoPath), 'the sample renders the fallback tile').toBe(true)
    test.info().annotations.push({
      type: 'assets checked',
      description: `${referenced.size} same-origin files from ${samplePages.length} pages`
    })
    for (const [path, referrer] of referenced) await expectServed(request, path, referrer)
    expect(failedLoads).toEqual([])
  })
})
