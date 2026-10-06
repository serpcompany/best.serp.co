import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import { detailListing } from './listing-fixture'

/**
 * A listing image never renders as a broken image (serpcompany/best.serp.co#122): every image
 * request but the #86 tile answers 404 here, and every listing image (cards, the detail page's
 * logo and featured image, the previous and next links) must end as the tile, loaded, with no
 * alt text or broken-image icon on screen.
 */
const tilePath = '/listing-logos/favicon-fallback-512x512.png'
const pages = ['/', detailListing.path]

/** Every image request but the tile answers 404, whatever its host. */
async function breakListingImages(context: BrowserContext): Promise<void> {
  await context.route('**/*', route => {
    const request = route.request()
    if (request.resourceType() === 'image' && new URL(request.url()).pathname !== tilePath) {
      return route.fulfill({ body: 'Not found', contentType: 'text/plain', status: 404 })
    }
    return route.continue()
  })
}

/**
 * Scrolls each listing image on screen into view, so lazy images load (and fail) too. A hidden
 * one (the other layout of a responsive list) never loads, so it never shows anything either.
 */
async function loadEveryListingImage(page: Page): Promise<number> {
  const images = page.locator('img[data-listing-image]:visible')
  const count = await images.count()
  for (let index = 0; index < count; index += 1) {
    await images.nth(index).scrollIntoViewIfNeeded()
  }
  return count
}

/** Listing images that are not the loaded tile: a broken one would show its alt text. */
async function notTheLoadedTile(page: Page): Promise<string[]> {
  return page.locator('img[data-listing-image]').evaluateAll((images, tile) => {
    return images.flatMap(element => {
      const image = element as HTMLImageElement
      if (!image.checkVisibility()) return []
      const loaded = image.complete && image.naturalWidth > 0
      return loaded && new URL(image.currentSrc || image.src).pathname === tile
        ? []
        : [`${image.getAttribute('alt')} ${image.getAttribute('src')} loaded=${loaded}`]
    })
  }, tilePath)
}

test.describe('listing image fallback (#122)', () => {
  test('a 404 listing image becomes the fallback tile, never alt text', async ({
    context,
    page
  }) => {
    await breakListingImages(context)
    for (const path of pages) {
      const response = await page.goto(path, { waitUntil: 'networkidle' })
      expect(response?.status(), path).toBe(200)
      expect(await loadEveryListingImage(page), path).toBeGreaterThan(0)
      await expect.poll(() => notTheLoadedTile(page), { message: path }).toEqual([])
    }

    // The detail page: the hero logo and the featured image both fell back.
    const hero = page.getByRole('img', { name: `${detailListing.name} fallback logo` }).first()
    await expect(hero).toBeVisible()
    await expect(hero).toHaveAttribute('src', tilePath)
    await expect(page.locator('img[data-listing-image="image"]')).toHaveAttribute('src', tilePath)
  })

  test('before hydration, a broken listing image is covered by the tile', async ({ browser }) => {
    // No JavaScript: nothing can swap the image, so the broken <img> draws its ::after tile.
    const context = await browser.newContext({ javaScriptEnabled: false })
    try {
      await breakListingImages(context)
      const page = await context.newPage()
      await page.goto(detailListing.path, { waitUntil: 'networkidle' })
      const covers = await page.locator('img[data-listing-image]').evaluateAll(images =>
        images.map(element => {
          const image = element as HTMLImageElement
          const after = getComputedStyle(image, '::after')
          return {
            broken: image.complete && image.naturalWidth === 0,
            content: after.content,
            cover: after.backgroundImage,
            position: after.position
          }
        })
      )
      const broken = covers.filter(cover => cover.broken)
      expect(broken.length).toBeGreaterThan(0)
      for (const cover of broken) {
        expect(cover.content).toBe('""')
        expect(cover.position).toBe('absolute')
        expect(cover.cover).toContain(tilePath)
      }
      await test.info().attach('detail-without-javascript', {
        body: await page.screenshot({ fullPage: false }),
        contentType: 'image/png'
      })
    } finally {
      await context.close()
    }
  })
})
