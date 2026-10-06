import { expect, type Page, test } from '@playwright/test'
import {
  hostedMediaListing,
  mediaOrigin,
  mediaServerEnabled,
  queuedMediaListing
} from './media-fixture'
import { listingPath, site } from './site-fixture'

/**
 * Hosted listing media against local R2 (serpcompany/best.serp.co#95), on the seeded media
 * server (`tests/media-fixture.ts`). Locally the bucket is served by the Worker at `/_media`;
 * staging and production use their media host instead.
 */
const keyPath =
  /^\/_media\/best\.serp\.co\/listings\/[a-z0-9._-]+\/(?:logo|image)\/[0-9a-f]{16}\.png$/u
const fallbackLogoPath = '/listing-logos/favicon-fallback-512x512.png'

test.skip(!mediaServerEnabled, 'The media server runs only when Playwright starts its own servers.')

async function naturalWidth(page: Page, name: string): Promise<number> {
  const image = page.getByRole('img', { name }).first()
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  return image.evaluate(element => (element as HTMLImageElement).naturalWidth)
}

test.describe('hosted listing media', () => {
  test('a listing renders its logo and featured image from the media bucket', async ({
    page,
    request
  }) => {
    const response = await page.goto(`${mediaOrigin}${listingPath(hostedMediaListing.slug)}`)
    expect(response?.status()).toBe(200)

    const logo = page
      .getByRole('main')
      .getByRole('img', { name: / logo$/u })
      .first()
    const featured = page.getByRole('img', { name: `${hostedMediaListing.name} featured image` })
    const logoSrc = (await logo.getAttribute('src')) ?? ''
    const featuredSrc = (await featured.getAttribute('src')) ?? ''
    expect(logoSrc).toMatch(keyPath)
    expect(logoSrc).toContain('/logo/')
    expect(featuredSrc).toMatch(keyPath)
    expect(featuredSrc).toContain('/image/')
    expect(await naturalWidth(page, `${hostedMediaListing.name} featured image`)).toBe(1200)

    for (const src of [logoSrc, featuredSrc]) {
      const media = await request.get(`${mediaOrigin}${src}`)
      expect(media.status(), src).toBe(200)
      expect(media.headers()['content-type']).toBe('image/png')
      expect(media.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(media.headers()['x-content-type-options']).toBe('nosniff')
    }

    const graph = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
    expect(JSON.stringify(graph)).toContain(
      JSON.stringify({ '@type': 'ImageObject', url: new URL(logoSrc, site.publicUrl).href })
    )
  })

  test('a logo still waiting for the cron shows the fallback tile, never its source', async ({
    page,
    request
  }) => {
    const path = `${mediaOrigin}${listingPath(queuedMediaListing.slug)}`
    await page.goto(path)
    const tile = page.getByRole('img', { name: `${queuedMediaListing.name} fallback logo` }).first()
    await expect(tile).toHaveAttribute('src', fallbackLogoPath)
    expect(await page.content()).not.toContain(queuedMediaListing.source)

    // A cron run retries the slot (its source is unreachable) and still hotlinks nothing.
    const cron = await request.get(`${mediaOrigin}/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*`)
    expect(cron.status()).toBe(200)
    await page.goto(path)
    expect(await page.content()).not.toContain(queuedMediaListing.source)
  })

  test('the local media route serves only listing media keys', async ({ request }) => {
    for (const path of [
      '/_media/serp.co/index.html',
      '/_media/best.serp.co/listings/x/logo/0123456789abcdef.png',
      '/_media/best.serp.co%2Flistings%2F..%2Fsecret.png'
    ]) {
      expect((await request.get(`${mediaOrigin}${path}`)).status(), path).toBe(404)
    }
  })
})
