import { expect } from '@playwright/test'
import { site } from './site-fixture'
import { test } from './test'

test.describe('Homepage', () => {
  test('should load successfully', async ({ page }) => {
    // Navigate to the homepage
    await page.goto('/')

    // Wait for the page to be fully loaded
    await page.waitForLoadState('domcontentloaded')

    // Verify that we're on the homepage by checking the URL
    await expect(page).toHaveURL(/\/$/)

    // Check that the best.serp.co homepage rendered
    await expect(page).toHaveTitle(site.title)
  })
})
