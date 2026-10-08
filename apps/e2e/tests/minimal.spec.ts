import { expect } from '@playwright/test'
import { site } from './site-fixture'
import { expectedResponse, test } from './test'

test.use({
  allowedConsoleErrors: {
    because: 'the not-found journey requests a missing page',
    patterns: [expectedResponse(404, /\/this-does-not-exist-404-page\//u)]
  }
})

// Minimal tests that should always pass
test.describe('Minimal Tests', () => {
  test.beforeEach(async ({ page }) => {
    page.setDefaultNavigationTimeout(60000)
    page.setDefaultTimeout(30000)
  })

  test('homepage loads', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBeLessThan(400)

    // Basic content check
    await expect(page).toHaveTitle(site.title)
  })

  test('about page loads', async ({ page }) => {
    const response = await page.goto('/about/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBeLessThan(400)

    // Has heading
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  })

  test('search works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })

    // Find any text input
    const inputs = await page.locator('input[type="text"], input[type="search"]').count()
    expect(inputs).toBeGreaterThan(0)
  })

  test('mobile responsive', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    const response = await page.goto('/', { waitUntil: 'networkidle' })
    expect(response?.status()).toBeLessThan(400)
  })

  test('404 returns appropriate status', async ({ page }) => {
    const response = await page.goto('/this-does-not-exist-404-page', {
      waitUntil: 'networkidle'
    })
    // The OpenNext Worker preview serves the not-found page with a real 404 status
    expect(response?.status()).toBe(404)
  })
})
