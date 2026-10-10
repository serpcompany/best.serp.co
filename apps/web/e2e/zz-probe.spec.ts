import { expect } from '@playwright/test'
import { startFixtureSite } from './submit-fixture'
import { test } from './test'

test('probe badge cooldown', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const fixture = await startFixtureSite()
  const label = `probe-${Date.now().toString(36)}`
  fixture.set(label, { badge: 'missing', description: 'Probe product for the cooldown.', name: 'Probe' })
  const context = await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '198.18.3.4' } })
  const headers = { origin: new URL(baseURL ?? '').origin }
  const email = `probe-${Date.now()}@example.com`
  await context.request.post('/api/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' }, headers })
  const { otp } = await (await context.request.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)).json()
  await context.request.post('/api/auth/sign-in/email-otp', { data: { email, otp }, headers })
  const page = await context.newPage()
  const t0 = Date.now()
  page.on('console', m => console.log('console', m.type(), m.text()))
  page.on('crash', () => console.log('CRASH', Date.now() - t0))
  page.on('close', () => console.log('PAGE CLOSE', Date.now() - t0))
  context.on('close', () => console.log('CONTEXT CLOSE', Date.now() - t0))
  page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('nav', f.url(), Date.now() - t0) })
  await page.goto('/submit/')
  await page.getByLabel('Website URL').fill(fixture.website(label))
  await page.getByLabel('Website URL').blur()
  await expect(page.getByText('We filled in 3 fields')).toBeVisible()
  await page.getByRole('combobox', { name: 'Primary category' }).click()
  await page.getByRole('option', { name: 'Design Tools', exact: true }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL(/choose/u)
  await page.getByRole('button', { name: 'Get the badge code' }).click()
  await page.waitForURL(/badge/u)
  const verify = page.waitForResponse(r => r.url().includes('/verify'))
  await page.getByRole('button', { name: 'Verify badge' }).click()
  console.log('verify', JSON.stringify(await (await verify).json()).slice(0, 600))
  console.log('browser now', await page.evaluate(() => new Date().toISOString()))
  for (let i = 0; i < 10; i += 1) {
    console.log(i, await page.locator('[data-slot="card-action"]').innerText())
    await page.waitForTimeout(4000)
  }
  await fixture.close()
})
