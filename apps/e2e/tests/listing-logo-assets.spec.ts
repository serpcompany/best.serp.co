import { readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

import { detailListing } from './listing-fixture'
import {
  categoriesIndexPath,
  categoryPath,
  listingPath,
  sampleCategory,
  site
} from './site-fixture'

/** The checked-in "no logo" tile (serpcompany/best.serp.co#86). */
const fallbackLogoPath = '/listing-logos/favicon-fallback-512x512.png'
/** A published listing with no logo in D1. */
const logoLessListing = {
  name: '321tube Video Downloader',
  path: listingPath('321tube-downloader')
}
/** A published listing whose logo is a remote image (Cloudflare Images). */
const remoteLogoListingPath = listingPath('autoenhance.ai')
/**
 * Listings whose featured image is a `/media/products` file restored in
 * serpcompany/best.serp.co#89: a WebP, a JPEG, and a JPEG stored under a `.webp` name (as on
 * apps.serp.co, where the originals live; browsers decode images by content, not type).
 */
const restoredImageListings = [
  { name: 'Beeg Video Downloader', path: listingPath('beeg-downloader') },
  { name: 'Dailymotion Video Downloader', path: listingPath('dailymotion-downloader') },
  { name: 'Coomer Downloader', path: listingPath('coomer-downloader') }
]
/** The checked-in listing images the catalog points at with root-relative URLs. */
const productMediaDirectory = resolve(__dirname, '../../web/public/media/products')

/**
 * Pages a visitor reaches first, plus listings whose logo is local (123movies), remote
 * (autoenhance.ai), and absent (321tube), and listings with a local featured image.
 */
const samplePages = [
  '/',
  '/products/',
  categoriesIndexPath,
  categoryPath(sampleCategory.slug),
  '/about/',
  '/search/?q=video',
  detailListing.path,
  remoteLogoListingPath,
  logoLessListing.path,
  ...restoredImageListings.map(listing => listing.path)
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

/** Every file under a directory, as URL paths relative to it. */
function filePaths(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
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
    for (const path of [detailListing.path, remoteLogoListingPath]) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      const heroLogo = page
        .getByRole('main')
        .getByRole('img', { name: / logo$/u })
        .first()
      const logoSrc = await heroLogo.getAttribute('src')
      expect(logoSrc, `${path} hero logo`).toBeTruthy()
      expect(logoSrc).not.toBe(fallbackLogoPath)

      const primaryImage = webPageNode(await structuredData(page)).primaryImageOfPage
      expect(primaryImage, path).toEqual({
        '@type': 'ImageObject',
        url: new URL(logoSrc ?? '', site.publicUrl).href
      })
    }
  })

  test('the Worker serves every checked-in /media/products file as an image', async ({
    request
  }) => {
    const files = filePaths(productMediaDirectory)
    // launchbuzz.io's og.png and the 35 files restored in #89.
    expect(files.length).toBeGreaterThanOrEqual(36)
    for (const file of files) {
      const path = `/media/products/${file}`
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(200)
      expect(response.headers()['content-type'], path).toMatch(/^image\//u)
      expect((await response.body()).length, path).toBeGreaterThan(1000)
    }
  })

  test('restored product images decode as the featured image on their listing pages', async ({
    page
  }) => {
    for (const listing of restoredImageListings) {
      const response = await page.goto(listing.path, { waitUntil: 'domcontentloaded' })
      expect(response?.status(), listing.path).toBe(200)

      const image = page.getByRole('img', { name: `${listing.name} featured image` })
      await expect(image).toHaveAttribute('src', /^\/media\/products\//u)
      await expect
        .poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth), {
          message: `${listing.path} featured image decodes`
        })
        .toBeGreaterThan(0)
    }
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
