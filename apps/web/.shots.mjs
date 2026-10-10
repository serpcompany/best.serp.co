import { chromium } from '@playwright/test'
const base = 'http://127.0.0.1:9249'
const out = process.argv[2]
const browser = await chromium.launch()

// One admin session (the seeded allowlisted admin), reused by every admin context.
const signIn = await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '198.18.7.9' } })
const headers = { origin: base }
const email = 'shots-admin@example.com'
let r = await signIn.request.post(`${base}/api/auth/email-otp/send-verification-otp`, { data: { email, type: 'sign-in' }, headers })
if (!r.ok()) throw new Error(`otp ${r.status()} ${await r.text()}`)
await new Promise(resolve => setTimeout(resolve, 1500))
const { otp } = await (await signIn.request.get(`${base}/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)).json()
r = await signIn.request.post(`${base}/api/auth/sign-in/email-otp`, { data: { email, otp }, headers })
if (!r.ok()) throw new Error(`sign-in ${r.status()} ${await r.text()}`)
const storageState = await signIn.storageState()
await signIn.close()

const errors = []
{
  const admin = await browser.newContext({ storageState })
  const page = await admin.newPage()
  await page.goto(`${base}/admin/listings/fixture-canvas/`)
  const before = await page.locator('[data-slot="combobox-chip"]').allTextContents()
  await page.getByLabel('Tags', { exact: true }).click()
  if (!before.includes('Developer APIs')) {
    await page.getByRole('option', { name: 'Developer APIs' }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Save tags' }).click()
    await page.getByText('Saved.').waitFor()
  }
  await page.reload()
  await page.getByRole('button', { name: 'Save tags' }).waitFor()
  console.log('canvas tags', before, '->', await page.locator('[data-slot="combobox-chip"]').allTextContents())
  console.log('activity', await page.getByText('Details edited: tags').count())
  await admin.close()
}
for (const theme of ['light', 'dark']) {
  for (const width of [1440, 390]) {
    const viewport = { width, height: width > 500 ? 1000 : 844 }
    const deviceScaleFactor = width > 500 ? 1 : 2
    // Submit: a hub chosen, two tags, the list open with that hub's tags first.
    const visitor = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor })
    const page = await visitor.newPage()
    page.on('console', m => { if (m.type() === 'error') errors.push(`submit ${theme} ${width}: ${m.text()}`) })
    await page.goto(`${base}/submit/`)
    await page.getByRole('combobox', { name: 'Primary category' }).click()
    await page.getByRole('option', { name: 'Design Tools', exact: true }).click()
    await page.getByLabel('Tags').click()
    await page.getByRole('option', { name: 'Whiteboards' }).click()
    await page.getByRole('option', { name: 'Note Taking' }).click()
    await page.getByLabel('Name').evaluate(el => el.scrollIntoView({ block: 'start' }))
    await page.evaluate(() => window.scrollBy(0, -24))
    await page.getByLabel('Tags').click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/submit-${width}-${theme}.png` })
    await visitor.close()

    // Admin listing page: the Tags card, its list open, grouped by hub.
    const admin = await browser.newContext({
      viewport: width > 500 ? { width, height: 1300 } : viewport,
      colorScheme: theme,
      deviceScaleFactor,
      storageState
    })
    const adminPage = await admin.newPage()
    adminPage.on('console', m => { if (m.type() === 'error') errors.push(`admin ${theme} ${width}: ${m.text()}`) })
    await adminPage.goto(`${base}/admin/listings/fixture-studio/`)
    await adminPage.getByRole('button', { name: 'Save tags' }).waitFor()
    const field = adminPage.getByLabel('Tags', { exact: true })
    await field.evaluate(el => el.scrollIntoView({ block: 'start' }))
    await adminPage.evaluate(() => window.scrollBy(0, -140))
    await field.click()
    await adminPage.waitForTimeout(400)
    await adminPage.screenshot({ path: `${out}/admin-${width}-${theme}.png` })
    await admin.close()
  }
}
console.log(errors.join('\n') || 'no console errors')
await browser.close()
