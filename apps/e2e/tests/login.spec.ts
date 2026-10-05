import { expect, type Page, test } from '@playwright/test'

/**
 * The sign-in screens in a browser against the local Worker (serpcompany/best.serp.co#60, the
 * #70 mockups): `/login` from email to code to signed in, the header's signed-in state and
 * sign-out, the error states, and `/account`. Codes come from the local dev outbox.
 */

function unique(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function uniqueEmail(label: string): string {
  return `e2e-ui-${label}-${unique()}@example.com`
}

/** A documentation-range client address, so each test has its own per-client limits. */
function uniqueIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.19.${octet()}.${octet()}`
}

async function asClient(page: Page): Promise<string> {
  const ip = uniqueIp()
  await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': ip })
  return ip
}

async function outboxCode(page: Page, email: string): Promise<string> {
  const response = await page.request.get(
    `/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`
  )
  const { otp } = (await response.json()) as { otp: string | null }
  expect(otp).toMatch(/^\d{6}$/u)
  return otp as string
}

async function requestCodeInPage(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
}

/** Types a code into the slots, replacing whatever the last guess left there. */
async function typeCode(page: Page, code: string): Promise<void> {
  const input = page.locator('#code')
  await input.fill('')
  await input.fill(code)
}

/** The `index`th wrong code: a different one each time, since the slots keep the last guess. */
function wrongCode(code: string, index = 0): string {
  const candidates = ['000000', '111111', '222222', '333333'].filter(value => value !== code)
  return candidates[index] ?? '444444'
}

test.describe('sign-in screens', () => {
  test('signs in with the emailed code, shows the account, and signs out from the header', async ({
    page
  }) => {
    await asClient(page)
    const email = uniqueEmail('flow')
    await page.goto('/login/')
    await expect(page).toHaveTitle(/Sign up or sign in/u)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u)
    await expect(page.getByRole('heading', { name: 'Sign up or sign in' })).toBeVisible()

    await requestCodeInPage(page, email)
    // The answer is the same whether or not an email went out (docs/ACCOUNTS.md).
    await expect(page.getByText(`If ${email} is a valid address`)).toBeVisible()
    // The 60-second resend countdown starts at 1:00, never above it.
    await expect(page.getByText(/Resend in (?:1:00|0:[0-5]\d)/u)).toBeVisible()

    await typeCode(page, await outboxCode(page, email))
    await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible()
    await expect(page.getByText('Redirecting…')).toBeVisible()

    // The default destination is the account dashboard, without the public header.
    await page.waitForURL('**/account/')
    await expect(page.getByRole('heading', { name: 'No listings yet' })).toBeVisible()
    await expect(page.getByText(email).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign up / Sign in' })).toHaveCount(0)

    // Public pages show the signed-in header: Account and Sign out.
    await page.goto('/about/')
    const header = page.locator('header').first()
    await expect(header.getByRole('link', { name: 'Account' })).toBeVisible()
    await header.getByRole('button', { name: 'Sign out' }).click()
    await expect(header.getByRole('link', { name: 'Sign up / Sign in' })).toBeVisible()

    // Signed out, /account sends the visitor to /login and back.
    await page.goto('/account/')
    await page.waitForURL(/\/login\/\?callbackUrl=%2Faccount%2F$/u)
  })

  // PR #76 review, finding 1: a callback that normalizes to `//host` never leaves the site.
  test('keeps the post-login redirect on this site', async ({ baseURL, page }) => {
    await asClient(page)
    const email = uniqueEmail('redirect')
    const origin = new URL(baseURL ?? '').origin
    await page.goto('/login/?callbackUrl=%2F.%2F%2Fevil.example%2Fphish')
    await requestCodeInPage(page, email)
    await typeCode(page, await outboxCode(page, email))
    await expect(page.getByRole('link', { name: 'Continue to your account' })).toHaveAttribute(
      'href',
      '/account/'
    )
    await page.waitForURL(`${origin}/account/`)
    // Signed in already, the same trick on /login redirects to the account page too.
    await page.goto('/login/?callbackUrl=%2Fx%2F..%2F%2Fevil.example%2F')
    await page.waitForURL(`${origin}/account/`)
    expect(new URL(page.url()).origin).toBe(origin)
  })

  test('signs out from the account menu', async ({ page }) => {
    await asClient(page)
    const email = uniqueEmail('menu')
    await page.goto('/login/?callbackUrl=%2Faccount%2F')
    await requestCodeInPage(page, email)
    await typeCode(page, await outboxCode(page, email))
    await page.waitForURL('**/account/')
    await page.getByRole('button', { name: email }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await page.waitForURL(url => url.pathname === '/')
    await expect(page.getByRole('link', { name: 'Sign up / Sign in' }).first()).toBeVisible()
  })

  test('counts down the attempts on a wrong code, then asks for a new code', async ({ page }) => {
    await asClient(page)
    const email = uniqueEmail('wrong')
    await page.goto('/login/')
    await requestCodeInPage(page, email)
    const code = await outboxCode(page, email)
    const input = page.locator('#code')

    await typeCode(page, wrongCode(code, 0))
    await expect(
      page.getByText(
        'That code isn’t right. Check the most recent email and try again. 2 attempts left.'
      )
    ).toBeVisible()
    // The six digits stay in the slots, and the real input is marked invalid and described.
    await expect(input).toHaveValue(wrongCode(code, 0))
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(input).toHaveAttribute('aria-describedby', 'code-error')
    await typeCode(page, wrongCode(code, 1))
    await expect(page.getByText(/1 attempt left\.$/u)).toBeVisible()
    await typeCode(page, wrongCode(code, 2))
    await expect(
      page.getByText('Too many incorrect codes. Request a new code to try again.')
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send a new code' }).first()).toBeVisible()
  })

  // PR #76 review, finding 3: a resend a per-email limit drops still leaves the old code.
  test('keeps counting the old code’s attempts after a resend within the minute', async ({
    page
  }) => {
    await asClient(page)
    const email = uniqueEmail('resend')
    await page.goto('/login/')
    await requestCodeInPage(page, email)
    const code = await outboxCode(page, email)
    await typeCode(page, wrongCode(code, 0))
    await expect(page.getByText(/2 attempts left\.$/u)).toBeVisible()
    await typeCode(page, wrongCode(code, 1))
    await expect(page.getByText(/1 attempt left\.$/u)).toBeVisible()
    // Within the minute the per-email cooldown answers like a sent code but sends nothing.
    await page.getByRole('button', { name: 'Send a new code' }).click()
    await expect(page.getByText(/Resend in (?:1:00|0:[0-5]\d)/u)).toBeVisible()
    expect(await outboxCode(page, email)).toBe(code)
    await typeCode(page, wrongCode(code, 2))
    await expect(
      page.getByText('Too many incorrect codes. Request a new code to try again.')
    ).toBeVisible()
  })

  test('explains an expired code', async ({ page }) => {
    await asClient(page)
    const email = uniqueEmail('expired')
    await page.goto('/login/')
    await requestCodeInPage(page, email)
    // A real code lives ten minutes; this answers the guess the way the server does then.
    await page.route('**/api/auth/sign-in/email-otp', route =>
      route.fulfill({
        body: JSON.stringify({ code: 'OTP_EXPIRED', message: 'OTP expired' }),
        contentType: 'application/json',
        status: 400
      })
    )
    await typeCode(page, await outboxCode(page, email))
    await expect(page.getByText('This code has expired. Codes work for 10 minutes.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send a new code' }).first()).toBeVisible()
  })

  test('shows the per-client limit with its wait and disables the button', async ({
    baseURL,
    page
  }) => {
    const ip = await asClient(page)
    for (let index = 0; index < 5; index += 1) {
      const response = await page.request.post('/api/auth/email-otp/send-verification-otp', {
        data: { email: uniqueEmail(`limit-${index}`), type: 'sign-in' },
        headers: { 'cf-connecting-ip': ip, origin: new URL(baseURL ?? '').origin }
      })
      expect(response.status()).toBe(200)
    }
    await page.goto('/login/')
    await page.getByLabel('Email').fill(uniqueEmail('limited'))
    await page.getByRole('button', { name: 'Email me a code' }).click()
    await expect(page.getByText('Too many code requests')).toBeVisible()
    await expect(
      page.getByText(/^Try again in .+, or use the most recent code we sent\.$/u)
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Email me a code' })).toBeDisabled()
  })

  test('explains that codes cannot be sent when delivery is unavailable', async ({ page }) => {
    await asClient(page)
    await page.goto('/login/')
    await page.route('**/api/auth/email-otp/send-verification-otp', route =>
      route.fulfill({
        body: JSON.stringify({ code: 'OTP_DELIVERY_UNAVAILABLE', message: 'x' }),
        contentType: 'application/json',
        status: 503
      })
    )
    await page.getByLabel('Email').fill(uniqueEmail('unavailable'))
    await page.getByRole('button', { name: 'Email me a code' }).click()
    await expect(page.getByText('Sign-in codes aren’t available right now')).toBeVisible()
  })

  test('signs out from the mobile menu', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    await asClient(page)
    const email = uniqueEmail('mobile')
    await page.goto('/login/?callbackUrl=%2Fabout%2F')
    await requestCodeInPage(page, email)
    await typeCode(page, await outboxCode(page, email))
    await page.waitForURL('**/about/')
    await page.getByRole('button', { name: 'Open menu' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('button', { name: 'Open menu' }).click()
    await expect(page.getByRole('link', { name: 'Sign up / Sign in' }).last()).toBeVisible()
  })
})
