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

    // Only the page itself is current, never "All products" as well (#259 review). Read from the
    // server HTML: after the menu closes, Base UI unmounts its popup, and on a slow host that
    // happens before the client navigation finishes, so the live DOM may hold no menu links.
    const categoriesHtml = await (await request.get('/products/categories/')).text()
    const currentLinks = [
      ...categoriesHtml.matchAll(/<a\b[^>]*data-slot="navigation-menu-link"[^>]*>/gu)
    ]
      .map(([tag]) => tag)
      .filter(tag => tag.includes('aria-current="page"'))
      .map(tag => /href="([^"]*)"/u.exec(tag)?.[1])
    expect(currentLinks.length).toBeGreaterThan(0)
    expect(new Set(currentLinks)).toEqual(new Set(['/products/categories/']))

    // The Products button marks its section (#259 review).
    await expect(nav.getByRole('button', { name: 'Products' })).toHaveAttribute('data-active', '')

    // And the live header follows the client navigation: reopened, the menu marks Categories.
    await nav.getByRole('button', { name: 'Products' }).click()
    const reopened = page.locator('[data-slot="navigation-menu-content"]')
    await expect(reopened.getByRole('link', { name: 'Categories', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await expect(reopened.locator('a[aria-current="page"]')).toHaveCount(1)
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

  test('listing grids are lists in one, two, then three columns (#264, #268)', async ({ page }) => {
    for (const [path, selector] of [
      ['/', 'section[aria-labelledby="featured"] [data-slot="card-grid"]'],
      [categoryPath(sampleCategory.slug), 'main [data-slot="card-grid"]'],
      ['/search/?q=video', 'main [data-slot="card-grid"]']
    ] as const) {
      await page.setViewportSize({ width: 1440, height: 900 })
      await gotoPublicPage(page, path)
      const grid = page.locator(selector).first()
      // Each card is a list item (#264 review).
      expect(await grid.evaluate(element => element.tagName), path).toBe('UL')
      for (const [width, expected] of [
        [1440, 3],
        [820, 2],
        [390, 1]
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await expect
          .poll(
            () =>
              grid.evaluate(
                element => getComputedStyle(element).gridTemplateColumns.split(' ').length
              ),
            { message: `${path} at ${width}px` }
          )
          .toBe(expected)
      }
      // A long listing name must not widen the phone column past the screen (#268).
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${path} scroll width at 390px`
      ).toBeLessThanOrEqual(390)
    }
  })

  test("the product page is serplists' detail page (#273)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoPublicPage(page, detailListing.path)
    const breadcrumb = page.getByRole('navigation', { name: 'breadcrumb' })
    await expectInternalLink(breadcrumb.getByRole('link', { name: 'Home' }), /^\/$/u)
    await expectInternalLink(breadcrumb.getByRole('link', { name: 'Products' }), /^\/products\/$/u)
    const header = page.locator('[data-slot="detail-page-header"]')
    await expect(
      header.getByRole('heading', { level: 1, name: detailListing.namePattern })
    ).toBeVisible()
    const visit = header.getByRole('link', { name: 'Visit Site' })
    await expect(visit).toHaveAttribute('target', '_blank')
    await expect(visit).toHaveAttribute('rel', /\bnoopener\b/u)
    // The panel beside the header holds the badge embed.
    await expect(
      page.getByRole('complementary').getByRole('button', { name: 'Copy light badge embed code' })
    ).toBeVisible()

    // The previous and next listings sit side by side, and nothing scrolls sideways on phones.
    const browse = page.locator('section[aria-labelledby="browse-more-heading"] ul')
    for (const [width, expected] of [
      [1440, 2],
      [390, 1]
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await expect
        .poll(() =>
          browse.evaluate(
            element => getComputedStyle(element).gridTemplateColumns.split(' ').length
          )
        )
        .toBe(expected)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })

  test('the home search sends its query to /search/, by Enter or its button', async ({ page }) => {
    // The field filters the list once hydrated; typing earlier is lost, so retype until it does.
    await gotoPublicPage(page, '/')
    const field = page.getByPlaceholder('Search the directory...')
    await fillUntilVisible(field, 'video', page.getByText(/results? for "video"/u))
    await Promise.all([page.waitForURL(/\/search\/?\?q=video$/u), field.press('Enter')])

    await gotoPublicPage(page, '/')
    const homeField = page.getByPlaceholder('Search the directory...')
    await fillUntilVisible(homeField, 'video', page.getByText(/results? for "video"/u))
    // The field's own button, found through its form.
    const button = page
      .locator('form')
      .filter({ has: homeField })
      .getByRole('button', { name: 'Search', exact: true })
    await Promise.all([page.waitForURL(/\/search\/?\?q=video$/u), button.click()])
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

  test('a category page keeps the chosen sort after reload (#269)', async ({ page }) => {
    await gotoPublicPage(page, categoryPath(sampleCategory.slug))
    const latest = page.getByRole('button', { name: /^latest$/i })
    await expect(page.getByRole('button', { name: /^name$/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    // The toggle is a client component; click until the hydrated one reacts.
    await expect(async () => {
      await latest.click()
      await expect(latest).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 })
    }).toPass()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /^latest$/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
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

  // The card title clips a brand link's own focus ring, so its card draws one (#278 review).
  test('a brand card shows a focus ring while its link has keyboard focus', async ({ page }) => {
    await gotoPublicPage(page, '/brands/')
    const card = page.locator('[data-list-card]').first()
    const link = card.locator('h2 a')
    const ring = () => card.evaluate(element => getComputedStyle(element).boxShadow)
    expect(await ring()).toBe('none')
    await page.keyboard.press('Tab')
    await link.focus()
    await expect(link).toBeFocused()
    await expect.poll(ring).not.toBe('none')
  })

  test("login is serplists' AuthCard, and the legal pages serp.co's docs layout (#277, #276)", async ({
    page
  }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await gotoPublicPage(page, '/login/')
      await expect(
        page.locator('[data-slot="auth-card"]').getByRole('heading', {
          level: 1,
          name: 'Sign up or sign in'
        })
      ).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )

      await gotoPublicPage(page, '/legal/privacy-policy/')
      const legalNav = page.getByRole('navigation', { name: 'Legal pages' })
      await expect(legalNav.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
        'aria-current',
        'page'
      )
      await expect(page.locator('article.prose-docs h2').first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )

      // The index: the legal nav on Overview and a card for each of the five policies (#282 review).
      await gotoPublicPage(page, '/legal/')
      await expect(
        page
          .getByRole('navigation', { name: 'Legal pages' })
          .getByRole('link', { name: 'Overview' })
      ).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('main [data-list-card] h2')).toHaveText([
        'Privacy Policy',
        'Terms of Service',
        'Cookie Policy',
        'Affiliate Disclosure',
        'DMCA'
      ])

      // The cookie policy's wide tables scroll in their own boxes, with padded cells (#282 review).
      await gotoPublicPage(page, '/legal/cookies/')
      await expect(page.locator('article.prose-docs table').first()).toBeVisible()
      expect(
        await page
          .locator('article.prose-docs td')
          .first()
          .evaluate(cell => Number.parseFloat(getComputedStyle(cell).paddingLeft))
      ).toBeGreaterThan(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      )
    }
  })

  // Controls styled with buttonVariants keep their own classes through cn (#186): the header's
  // account button is `hidden md:inline-flex`, so it waits for the menu on phones.
  test('the desktop-only account button stays hidden on phones', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    await gotoPublicPage(page, '/')
    const header = page.getByRole('banner')
    await expect(header.getByRole('button', { name: 'Account' })).toBeHidden()
    await expect(header.getByRole('button', { name: /open menu/i })).toBeVisible()
    await page.setViewportSize({ height: 900, width: 1440 })
    await expect(header.getByRole('button', { name: 'Account' })).toBeVisible()
  })

  // zenbujapanese.com's header (#286): Submit, then one account menu holding sign-in and the
  // theme. The theme toggle and the sign-in link are no longer in the header itself.
  test('the header account menu offers sign-in and switches the theme', async ({ page }) => {
    await page.setViewportSize({ height: 900, width: 1440 })
    await gotoPublicPage(page, '/')
    const header = page.getByRole('banner')
    await expect(header.getByRole('link', { name: 'Submit' })).toBeVisible()
    await expect(header.getByRole('link', { name: 'Sign up / Sign in' })).toHaveCount(0)
    await expect(header.getByRole('button', { name: 'Toggle dark mode' })).toHaveCount(0)

    await header.getByRole('button', { name: 'Account' }).click()
    await expect(page.getByRole('menuitem', { name: 'Sign up / Sign in' })).toHaveAttribute(
      'href',
      /^\/login\/?$/u
    )
    await page.getByRole('menuitemradio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/u)
    await page.getByRole('menuitemradio', { name: 'Light' }).click()
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/u)
    // System follows the browser's color scheme.
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.getByRole('menuitemradio', { name: 'System' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/u)
  })
})
