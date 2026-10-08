import { expect, type Locator } from '@playwright/test'
import { adminSuiteEnabled, client, signIn, unique } from './admin-fixture'
import { test } from './test'

/**
 * The public site is square through one rule (#185): while `SiteChrome` (`data-site-chrome`) is
 * on the page, `--radius` is 0, and the radius scale is multiples of it. The dashboards keep
 * 0.5rem. Renaming the attribute or dropping the rule would round the public site again, and
 * only computed styles show it.
 */
async function cornerRadius(element: Locator): Promise<string> {
  return element.evaluate(node => getComputedStyle(node).borderTopLeftRadius)
}

test('the public site is square, its portals and Markdown code blocks included', async ({
  page
}) => {
  await page.goto('/submit/')
  const trigger = page.getByRole('combobox', { name: 'Primary category' })
  expect(await cornerRadius(trigger)).toBe('0px')

  // The category list is a portal outside SiteChrome, under the same :root.
  await trigger.click()
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  expect(await cornerRadius(list)).toBe('0px')
  await page.keyboard.press('Escape')

  // MDX `pre` (mdx-components.tsx) takes `rounded-md` inside `.prose`, whose typography rule
  // would otherwise give it a fixed 0.375rem. No page in the catalog has a code block, so the
  // check adds one with the same classes to a legal page's prose.
  await page.goto('/legal/privacy-policy/')
  const radius = await page
    .locator('.prose')
    .first()
    .evaluate(prose => {
      const pre = document.createElement('pre')
      pre.className = 'mb-4 mt-6 overflow-x-auto rounded-md border border-border/50 p-4 text-sm'
      prose.append(pre)
      return getComputedStyle(pre).borderTopLeftRadius
    })
  expect(radius).toBe('0px')
})

test('the dashboards keep the 0.5rem radius', async ({ baseURL, page }) => {
  test.skip(!adminSuiteEnabled, 'signs in with the local dev code sender')
  if (!baseURL) throw new Error('Playwright baseURL is required.')
  await signIn(client(page.request, baseURL), `e2e-radius-${unique()}@example.com`)
  await page.goto('/account/')
  // A stock button is `rounded-md`: 0.75 × 0.5rem.
  const button = page.locator('main [data-slot="button"]').first()
  await expect(button).toBeVisible()
  expect(await cornerRadius(button)).toBe('6px')
})
