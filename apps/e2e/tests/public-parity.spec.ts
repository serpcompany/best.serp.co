import { expect, type Locator, type Page } from '@playwright/test'
import { detailListing } from './listing-fixture'
import { categoryPath, escapeRegExp, sampleCategory } from './site-fixture'
import { test } from './test'

async function gotoPublicPage(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('main').first()).toBeVisible()
  // Interactive controls are client components; let their chunks load before driving them.
  await page.waitForLoadState('networkidle')
}

/**
 * Client-side search controls ignore input typed before React hydrates the page, so re-type until
 * the hydrated component reacts instead of racing hydration with a single fill.
 */
async function fillUntilVisible(input: Locator, value: string, expected: Locator) {
  await expect(async () => {
    await input.fill('')
    await input.fill(value)
    await expect(expected).toBeVisible({ timeout: 2_000 })
  }).toPass()
}

async function expectInternalLink(link: Locator, expectedPath: RegExp | string) {
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  expect(href).toEqual(expect.stringMatching(expectedPath))
  expect(await link.getAttribute('target')).toBeNull()
  expect(await link.getAttribute('rel')).toBeNull()
}

async function expectExternalLink(link: Locator) {
  await expect(link).toBeVisible()
  const href = await link.getAttribute('href')
  expect(href).toEqual(expect.stringMatching(/^https?:\/\//))
  expect(await link.getAttribute('target')).toBe('_blank')
  expect(await link.getAttribute('rel')).toBe('noopener noreferrer')
}

test.describe('public parity interactions', () => {
  test('homepage search submit preserves search URL behavior', async ({ page }) => {
    await gotoPublicPage(page, '/')

    const searchForm = page.getByRole('form', { name: /desktop search/i })
    const searchInput = searchForm.getByRole('textbox', { name: /^search$/i })
    await searchInput.fill('video')

    await Promise.all([page.waitForURL(/\/search\/?\?q=video/), searchInput.press('Enter')])

    await expect(page.getByRole('heading', { name: /^search$/i })).toBeVisible()
  })

  test('desktop autocomplete keyboard selection preserves navigation behavior', async ({
    page
  }) => {
    await gotoPublicPage(page, '/')

    const searchForm = page.getByRole('form', { name: /desktop search/i })
    const searchInput = searchForm.getByRole('textbox', { name: /^search$/i })
    await fillUntilVisible(
      searchInput,
      detailListing.searchQuery,
      page.getByRole('option', { name: detailListing.namePattern })
    )

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(detailListing.path)}$`))
  })

  test('mobile search overlay opens, submits, closes, and unlocks body scroll', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoPublicPage(page, '/')

    await page.getByRole('button', { name: /toggle search/i }).click()

    const mobileSearchForm = page.getByRole('form', { name: /mobile search/i })
    await expect(mobileSearchForm).toBeVisible()
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')

    const searchInput = mobileSearchForm.getByRole('textbox', { name: /search listings/i })
    await searchInput.fill('video')
    await Promise.all([page.waitForURL(/\/search\/?\?q=video/), searchInput.press('Enter')])
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
  })

  test('mobile drawer opens, closes through Escape, locks scroll, and navigates', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoPublicPage(page, '/')

    await page.getByRole('button', { name: /open menu/i }).click()
    await expect(page.getByRole('heading', { name: /^menu$/i })).toBeVisible()
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: /^menu$/i })).not.toBeInViewport()
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')

    await page.getByRole('button', { name: /open menu/i }).click()
    await page.getByRole('link', { name: sampleCategory.name }).first().click()
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(categoryPath(sampleCategory.slug))}$`))
  })

  test('favorite toggle and favorites-only filter preserve local state behavior', async ({
    page
  }) => {
    await gotoPublicPage(page, '/')
    await page.evaluate(slug => {
      localStorage.setItem('llms-txt-hub-favorites', JSON.stringify([slug]))
    }, detailListing.slug)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('main').first()).toBeVisible()

    const favoritesOnlyButton = page.getByRole('button', { name: /favorites only/i })
    await expect(favoritesOnlyButton).toBeVisible()
    await favoritesOnlyButton.click()

    await expect(page.getByRole('button', { name: /show all/i })).toBeVisible()
    await expect(page.getByText(/showing \d+ of \d+ matching products/i)).toBeVisible()

    const removeFavoriteButton = page
      .getByRole('button', { name: /remove from favorites/i })
      .first()
    await removeFavoriteButton.click()
    await expect(page.getByRole('button', { name: /favorites only/i })).not.toBeVisible()
  })

  test('homepage sort choice persists after reload with result count text intact', async ({
    page
  }) => {
    await gotoPublicPage(page, '/')

    const browseSection = page.getByRole('heading', { name: /browse the directory/i })
    await browseSection.scrollIntoViewIfNeeded()
    const nameSortButton = page.getByRole('radio', { name: /^name$/i }).last()
    await nameSortButton.click()
    await expect(page.getByText(/showing \d+ of \d+ matching products/i)).toBeVisible()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('radio', { name: /^name$/i }).last()).toHaveAttribute(
      'data-state',
      'on'
    )
    await expect(page.getByText(/showing \d+ of \d+ matching products/i)).toBeVisible()
  })

  test('empty search state action link preserves submit href semantics', async ({ page }) => {
    await gotoPublicPage(page, '/')

    const browseSection = page.getByRole('heading', { name: /browse the directory/i })
    await browseSection.scrollIntoViewIfNeeded()
    const searchInput = page.getByPlaceholder('Search the directory...')
    await fillUntilVisible(
      searchInput,
      'phase-one-no-results-sentinel',
      page.getByRole('heading', { name: /no results found/i })
    )
    await page.getByRole('button', { name: /clear search/i }).click()
    await expect(page.getByRole('heading', { name: /no results found/i })).not.toBeVisible()
  })

  test('public link href target and rel semantics are preserved', async ({ page }) => {
    await gotoPublicPage(page, '/')

    await expectInternalLink(
      page.getByRole('banner').getByRole('link', { name: /^submit$/i }),
      /^\/submit\/$/
    )
    await expectInternalLink(
      page.getByRole('link', { name: detailListing.namePattern }).first(),
      new RegExp(`^${escapeRegExp(detailListing.path)}$`)
    )

    await gotoPublicPage(page, detailListing.path)
    await expectExternalLink(page.getByRole('link', { name: /install browser extension/i }).first())
  })
})
