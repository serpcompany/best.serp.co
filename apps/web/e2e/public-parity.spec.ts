import { expect, type Locator, type Page } from '@playwright/test'
import { detailListing } from './listing-fixture'
import { escapeRegExp } from './site-fixture'
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
  test('the mobile menu opens, closes through Escape back to its trigger, and navigates', async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoPublicPage(page, '/')

    const trigger = page.getByRole('button', { name: /open menu/i })
    await trigger.click()
    const menu = page.getByRole('dialog')
    await expect(menu.getByRole('navigation', { name: 'Site' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    await menu.getByRole('link', { name: 'Categories' }).click()
    await expect(page).toHaveURL(/\/products\/categories\/$/u)
  })

  test('the header menu is in the server HTML, opens on click, and navigates', async ({
    page,
    request
  }) => {
    // keepMounted: the closed menu's links are in the HTML crawlers read, before any script runs.
    const html = await (await request.get('/about/')).text()
    expect(html).toMatch(/<nav[^>]*aria-label="Site"[\s\S]*?href="\/products\/categories\/"/u)

    await gotoPublicPage(page, '/')
    const nav = page.getByRole('navigation', { name: 'Site' })
    await nav.getByRole('button', { name: 'Products' }).click()
    // An open menu's content moves into Base UI's popup, a portal outside the <nav>.
    await page
      .locator('[data-slot="navigation-menu-content"]')
      .getByRole('link', { name: 'Categories', exact: true })
      .click()
    await expect(page).toHaveURL(/\/products\/categories\/$/u)
    // Only the page itself is current, never "All products" as well (#259 review). Once opened,
    // the menu's links stay in its popup, outside <header>.
    const current = page.locator('a[data-slot="navigation-menu-link"][aria-current="page"]')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('href', '/products/categories/')
    // The Products button marks its section (#259 review).
    await expect(nav.getByRole('button', { name: 'Products' })).toHaveAttribute('data-active', '')
  })

  test('the search page has its own search field, holding the query', async ({ page }) => {
    await gotoPublicPage(page, '/search/?q=video')
    const field = page.getByRole('search').getByRole('searchbox', { name: 'Search' })
    await expect(field).toHaveValue('video')
    await field.fill('audio')
    await Promise.all([page.waitForURL(/\/search\/?\?q=audio$/u), field.press('Enter')])
    await expect(page.getByRole('search').getByRole('searchbox', { name: 'Search' })).toHaveValue(
      'audio'
    )
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

    // A Toggle (#188): its label stays put and its pressed state says it's on.
    await expect(favoritesOnlyButton).toHaveAttribute('aria-pressed', 'true')
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
    const nameSortButton = page.getByRole('button', { name: /^name$/i }).last()
    await nameSortButton.click()
    await expect(page.getByText(/showing \d+ of \d+ matching products/i)).toBeVisible()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /^name$/i }).last()).toHaveAttribute(
      'aria-pressed',
      'true'
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

  // Links styled with buttonVariants keep their own classes through cn (#186): the header's
  // sign-in link is `hidden md:inline-flex`, so it waits for the menu on phones.
  test('desktop-only header links stay hidden on phones', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    await gotoPublicPage(page, '/')
    const header = page.getByRole('banner')
    await expect(header.getByRole('link', { name: 'Sign up / Sign in' })).toBeHidden()
    await expect(header.getByRole('button', { name: /open menu/i })).toBeVisible()
    await page.setViewportSize({ height: 900, width: 1440 })
    await expect(header.getByRole('link', { name: 'Sign up / Sign in' })).toBeVisible()
  })
})
