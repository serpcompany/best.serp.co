import { expect } from '@playwright/test'
import { test } from './test'

/**
 * The public site wears the shared SERP theme (#255): Geist and Geist Mono from `next/font`,
 * through the variables on `<html>` that `globals.css` maps, and shadcn's stock radius. A
 * variable renamed on one side only would drop the site to the browser's default fonts while
 * every other check stayed green.
 */
test('the public site uses Geist, Geist Mono and the stock radius', async ({ page }) => {
  await page.goto('/about/')
  const theme = await page.evaluate(() => {
    const code = document.createElement('code')
    document.body.appendChild(code)
    return {
      body: getComputedStyle(document.body).fontFamily,
      code: getComputedStyle(code).fontFamily,
      radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()
    }
  })
  expect(theme.body).toMatch(/^Geist\b/u)
  expect(theme.code).toMatch(/^"?Geist Mono\b/u)
  // The built CSS is minified, so the value reads `.625rem`.
  expect(theme.radius).toMatch(/^0?\.625rem$/u)
})
