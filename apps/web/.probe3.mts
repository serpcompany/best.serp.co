import { chromium } from '@playwright/test'
import * as fixtureModule from './e2e/submit-fixture'
const startFixtureSite = (fixtureModule as any).startFixtureSite ?? (fixtureModule as any).default.startFixtureSite

const base = 'http://127.0.0.1:9249'
const browser = await chromium.launch()
browser.on('disconnected', () => console.log('BROWSER DISCONNECTED'))
const fixture = await startFixtureSite()
const label = `probe-${Date.now().toString(36)}`
fixture.set(label, { badge: 'missing', description: 'Probe product for the cooldown.', name: 'Probe' })
const context = await browser.newContext({ baseURL: base, extraHTTPHeaders: { 'cf-connecting-ip': '198.18.3.5' } })
const headers = { origin: base }
const email = `probe-${Date.now()}@example.com`
await context.request.post('/api/auth/email-otp/send-verification-otp', { data: { email, type: 'sign-in' }, headers })
const { otp } = await (await context.request.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)).json()
await context.request.post('/api/auth/sign-in/email-otp', { data: { email, otp }, headers })
const page = await context.newPage()
const t0 = Date.now()
page.on('crash', () => console.log('CRASH', Date.now() - t0))
page.on('close', () => console.log('PAGE CLOSE', Date.now() - t0))
page.on('pageerror', e => console.log('PAGEERROR', e.message))
page.on('console', m => console.log('console', m.type(), m.text()))
await page.goto('/submit/')
await page.getByLabel('Website URL').fill(fixture.website(label))
await page.getByLabel('Website URL').blur()
await page.getByText('We filled in 3 fields').waitFor()
await page.getByRole('combobox', { name: 'Primary category' }).click()
await page.getByRole('option', { name: 'Design Tools', exact: true }).click()
await page.getByRole('button', { name: 'Continue' }).click()
await page.waitForURL(/choose/u)
await page.getByRole('button', { name: 'Get the badge code' }).click()
await page.waitForURL(/badge/u)
await page.getByRole('button', { name: 'Verify badge' }).click()
for (let i = 0; i < 10; i += 1) {
  console.log(i, Date.now() - t0, await page.locator('[data-slot="card-action"]').innerText().catch(e => String(e).slice(0, 80)))
  await new Promise(r => setTimeout(r, 4000))
}
await fixture.close()
await browser.close()
