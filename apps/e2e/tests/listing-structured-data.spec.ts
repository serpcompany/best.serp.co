import { expect, test } from '@playwright/test'

import { detailListing } from './listing-fixture'
import { listingPath } from './site-fixture'

/**
 * The D1 catalog records no product pricing (serpcompany/best.serp.co#88), so a listing's
 * JSON-LD must not claim a price: no Offer at all, rather than a default "free" one. A free
 * download tool (123movies) and a paid photo editor (autoenhance.ai) are both unpriced.
 */
const unpricedListingPaths = [detailListing.path, listingPath('autoenhance.ai')]

test.describe('listing structured data', () => {
  for (const path of unpricedListingPaths) {
    test(`${path} describes the software without claiming a price`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' })
      expect(response?.status()).toBe(200)

      const data = await page
        .locator('script[type="application/ld+json"]')
        .evaluateAll(scripts => scripts.map(script => JSON.parse(script.textContent ?? 'null')))
      const nodes = data.flatMap(entry =>
        entry && typeof entry === 'object' && '@graph' in entry ? entry['@graph'] : [entry]
      ) as Array<Record<string, unknown>>
      const software = nodes.find(node => node?.['@type'] === 'SoftwareApplication')

      expect(software, 'listing JSON-LD has a SoftwareApplication node').toBeTruthy()
      expect(software?.name).toBeTruthy()
      expect(software).not.toHaveProperty('offers')
      expect(JSON.stringify(data)).not.toMatch(/"Offer"|"price"/u)
    })
  }
})
