import { expect, type Page, test } from '@playwright/test'

import { detailListing } from './listing-fixture'

const listingRouteBasePath = process.env.E2E_LISTING_ROUTE_BASE_PATH ?? 'products'
const categoryRouteBasePath = process.env.E2E_CATEGORY_ROUTE_BASE_PATH ?? 'categories'
const categorySlug = process.env.E2E_CATEGORY_SLUG ?? 'video-downloaders'

type ViewportName = 'desktop' | 'tablet' | 'mobile'

const viewports: Record<ViewportName, { width: number; height: number }> = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 }
}

const screenshotOptions = {
  fullPage: true,
  maxDiffPixelRatio: 0.02
} as const

async function prepareVisualPage(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }

      [data-nextjs-dev-tools-button],
      nextjs-portal {
        display: none !important;
      }

      [data-nextjs-toast],
      [data-nextjs-dialog-overlay] {
        display: none !important;
      }
    `
  })
  await expect(page.getByRole('main').first()).toBeVisible()
}

async function prepareVisualViewport(page: Page, viewport: ViewportName, path: string) {
  await page.setViewportSize(viewports[viewport])
  await prepareVisualPage(page, path)
}

test.describe('visual regression coverage', () => {
  test('homepage remains visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'desktop', '/')

    await expect(page).toHaveScreenshot('home-page.png', screenshotOptions)
  })

  test('listing detail page remains visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'desktop', `/${listingRouteBasePath}/${detailListing.slug}`)
    await expect(
      page.getByRole('heading', { level: 1, name: detailListing.namePattern })
    ).toBeVisible()

    await expect(page).toHaveScreenshot('listing-detail-page.png', screenshotOptions)
  })

  test('brands page remains visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'desktop', '/brands')

    await expect(page).toHaveScreenshot('brands-page.png', screenshotOptions)
  })

  test('search page remains visually stable', async ({ page }) => {
    await prepareVisualViewport(
      page,
      'desktop',
      `/search?q=${encodeURIComponent(detailListing.searchQuery)}`
    )
    await expect(page.getByRole('heading', { name: /results? for/i })).toBeVisible()

    await expect(page).toHaveScreenshot('search-page.png', screenshotOptions)
  })

  for (const viewport of ['desktop', 'tablet', 'mobile'] as const) {
    test(`pilot homepage ${viewport} remains visually stable`, async ({ page }) => {
      await prepareVisualViewport(page, viewport, '/')

      await expect(page).toHaveScreenshot(`pilot-home-page-${viewport}.png`, screenshotOptions)
    })

    test(`pilot search ${viewport} remains visually stable`, async ({ page }) => {
      await prepareVisualViewport(
        page,
        viewport,
        `/search?q=${encodeURIComponent(detailListing.searchQuery)}`
      )
      await expect(page.getByRole('heading', { name: /results? for/i })).toBeVisible()

      await expect(page).toHaveScreenshot(`pilot-search-page-${viewport}.png`, screenshotOptions)
    })

    test(`pilot category ${viewport} remains visually stable`, async ({ page }) => {
      await prepareVisualViewport(page, viewport, `/${categoryRouteBasePath}/${categorySlug}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

      await expect(page).toHaveScreenshot(`pilot-category-page-${viewport}.png`, screenshotOptions)
    })

    test(`pilot listing detail ${viewport} remains visually stable`, async ({ page }) => {
      await prepareVisualViewport(page, viewport, `/${listingRouteBasePath}/${detailListing.slug}`)
      await expect(
        page.getByRole('heading', { level: 1, name: detailListing.namePattern })
      ).toBeVisible()

      await expect(page).toHaveScreenshot(
        `pilot-listing-detail-page-${viewport}.png`,
        screenshotOptions
      )
    })
  }

  test('pilot empty search state remains visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'desktop', '/search?q=phase-one-no-results-sentinel')
    await expect(page.getByRole('heading', { name: /nothing found/i })).toBeVisible()

    await expect(page).toHaveScreenshot('pilot-empty-search-state-desktop.png', screenshotOptions)
  })

  test('pilot desktop autocomplete suggestions remain visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'desktop', '/')

    const searchForm = page.getByRole('form', { name: /desktop search/i })
    const searchInput = searchForm.getByRole('textbox', { name: /^search$/i })
    await searchInput.fill('123movies')
    await expect(page.getByRole('button', { name: /123movies downloader/i })).toBeVisible()

    await expect(page).toHaveScreenshot('pilot-autocomplete-desktop.png', screenshotOptions)
  })

  test('pilot favorites-only state remains visually stable when favorites exist', async ({
    page
  }) => {
    await page.addInitScript(slug => {
      localStorage.setItem('llms-txt-hub-favorites', JSON.stringify([slug]))
    }, detailListing.slug)
    await prepareVisualViewport(page, 'desktop', '/')

    const favoritesOnlyButton = page.getByRole('button', { name: /favorites only/i })
    await expect(favoritesOnlyButton).toBeVisible()
    await favoritesOnlyButton.click()
    await expect(page.getByRole('button', { name: /show all/i })).toBeVisible()

    await expect(page).toHaveScreenshot('pilot-favorites-only-desktop.png', screenshotOptions)
  })

  test('pilot sort and result count state remains visually stable', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('websites-sort-by', JSON.stringify('name'))
    })
    await prepareVisualViewport(page, 'desktop', '/')
    await expect(page.getByText(/showing \d+ of \d+ matching products/i)).toBeVisible()

    await expect(page).toHaveScreenshot('pilot-sort-result-count-desktop.png', screenshotOptions)
  })

  test('pilot mobile drawer open state remains visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'mobile', '/')

    await page.getByRole('button', { name: /open menu/i }).click()
    await expect(page.getByRole('heading', { name: /^menu$/i })).toBeVisible()

    await expect(page).toHaveScreenshot('pilot-mobile-drawer-open.png', screenshotOptions)
  })

  test('pilot mobile search overlay open state remains visually stable', async ({ page }) => {
    await prepareVisualViewport(page, 'mobile', '/')

    await page.getByRole('button', { name: /toggle search/i }).click()
    await expect(page.getByRole('form', { name: /mobile search/i })).toBeVisible()

    await expect(page).toHaveScreenshot('pilot-mobile-search-overlay-open.png', screenshotOptions)
  })
})
