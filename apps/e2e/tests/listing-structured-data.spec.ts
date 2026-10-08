import { expect, type Page } from '@playwright/test'
import { detailListing } from './listing-fixture'
import { categoryPath, listingPath, sampleCategory } from './site-fixture'
import { test } from './test'

/** Every JSON-LD node on a page, flattening any `@graph`; empty scripts are skipped. */
async function jsonLdNodes(page: Page): Promise<Array<Record<string, unknown>>> {
  const data: unknown[] = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent || 'null')))
  return data
    .flatMap(entry =>
      entry && typeof entry === 'object' && '@graph' in entry
        ? (entry['@graph'] as unknown[])
        : [entry]
    )
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object')
}

/**
 * The D1 catalog records no product pricing (serpcompany/best.serp.co#88), so a listing's
 * JSON-LD must not claim a price: no Offer at all, rather than a default "free" one. Both
 * listings here are paid products that the old default offer called free.
 */
const unpricedListingPaths = [detailListing.path, listingPath('autoenhance.ai')]

test.describe('listing structured data', () => {
  for (const path of unpricedListingPaths) {
    test(`${path} describes the software without claiming a price`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status()).toBe(200)

      const nodes = await jsonLdNodes(page)
      const software = nodes.find(node => node['@type'] === 'SoftwareApplication')

      expect(software, 'listing JSON-LD has a SoftwareApplication node').toBeTruthy()
      expect(software?.name).toBeTruthy()
      expect(software).not.toHaveProperty('offers')
      expect(JSON.stringify(nodes)).not.toMatch(/"Offer"|"price"/u)
    })
  }
})

const websiteId = 'https://best.serp.co/#website'

// One WebSite node, defined on the homepage, that every page points at (#166).
test.describe('the site JSON-LD graph', () => {
  test('the homepage defines the WebSite node, without a SearchAction', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const website = (await jsonLdNodes(page)).find(node => node['@type'] === 'WebSite')
    expect(website?.['@id']).toBe(websiteId)
    expect(website).not.toHaveProperty('potentialAction')
  })

  for (const [path, type] of [
    [detailListing.path, 'WebPage'],
    [categoryPath(sampleCategory.slug), 'CollectionPage'],
    ['/brands/', 'CollectionPage']
  ]) {
    test(`${path} points its ${type} at the homepage's WebSite node`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      const pageNode = (await jsonLdNodes(page)).find(node => node['@type'] === type)
      expect(pageNode?.isPartOf, `${path} ${type}.isPartOf`).toMatchObject({ '@id': websiteId })
    })
  }
})
