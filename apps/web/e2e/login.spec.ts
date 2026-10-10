import { expect, type Page } from '@playwright/test'
import { expectedResponse, test } from './test'

test.use({
  allowedConsoleErrors: {
    because:
      'the sign-in journeys exercise bad and blocked codes, the send caps, and email being off',
    patterns: [400, 403, 429, 503].map(status => expectedResponse(status, /\/api\/auth\//u))
  }
})

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

/** Puts `text` on the clipboard and pastes it into the code field with the keyboard. */
async function pasteIntoCode(page: Page, text: string): Promise<void> {
  await page.evaluate(value => navigator.clipboard.writeText(value), text)
  await page.locator('#code').focus()
  await page.keyboard.press('ControlOrMeta+V')
}

/**
 * Sets the code field's whole value the way browser autofill does: through the native setter,
 * so React sees a real change, then one input event.
 */
async function autofillCode(page: Page, value: string): Promise<void> {
  await page.locator('#code').evaluate((input: HTMLInputElement, text) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

/**
 * The signed-out header (#286): its account menu offers "Sign up / Sign in". Sign-out reloads
 * the page, so the menu is opened again until the reloaded header shows the signed-out item.
 */
async function expectSignedOutHeader(page: Page): Promise<void> {
  const account = page.locator('header').first().getByRole('button', { name: 'Account' })
  await expect(async () => {
    await page.keyboard.press('Escape')
    await account.click()
    await expect(page.getByRole('menuitem', { name: 'Sign up / Sign in' })).toBeVisible({
      timeout: 1000
    })
  }).toPass()
  await page.keyboard.press('Escape')
}

/** Counts the page's code guesses (`/api/auth/sign-in/email-otp` requests). */
function countGuesses(page: Page): { readonly count: number } {
  const guesses = { count: 0 }
  page.on('request', request => {
    if (request.url().includes('/api/auth/sign-in/email-otp')) guesses.count += 1
  })
  return guesses
}

/** Requests a code on a fresh client and returns it, with the page on the code step. */
async function codeStep(page: Page, label: string): Promise<string> {
  await page.context().clearCookies()
  await asClient(page)
  const email = uniqueEmail(label)
  await page.goto('/login/')
  await requestCodeInPage(page, email)
  return outboxCode(page, email)
}

/** A code as people copy it from an email or a phone: spaced, dashed, or padded. */
const COPIED_CODE_FORMATS: ReadonlyArray<[string, (code: string) => string]> = [
  ['"482 913"', code => `${code.slice(0, 3)} ${code.slice(3)}`],
  ['"482-913"', code => `${code.slice(0, 3)}-${code.slice(3)}`],
  ['" 482913\\n"', code => ` ${code}\n`],
  ['"482 913" with a no-break space', code => `${code.slice(0, 3)}\u00a0${code.slice(3)}`]
]

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
    await expect(page.getByRole('button', { name: 'Account, signed in' })).toHaveCount(0)

    // Public pages show the signed-in header: the account menu, with Account, the theme row
    // and Sign out.
    await page.goto('/about/')
    const header = page.locator('header').first()
    await header.getByRole('button', { name: 'Account, signed in' }).click()
    await expect(page.getByRole('menuitem', { name: 'Account' })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: 'System' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expectSignedOutHeader(page)

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
    await page.getByRole('button', { name: 'Account menu' }).click()
    await expect(page.getByRole('menu').getByText(email)).toBeVisible()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await page.waitForURL(url => url.pathname === '/')
    await expectSignedOutHeader(page)
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

  // PR #76 review 1, finding 3, and review 2, finding 2: a resend a per-email limit drops
  // leaves the old code. The screen keeps its misses, gives no count it cannot know, and lets
  // the server say when the code is spent.
  test('keeps the old code after a resend within the minute, until the server says it is spent', async ({
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
    // The old code's third miss: the server still answers "wrong", and the screen claims no count.
    await typeCode(page, wrongCode(code, 2))
    await expect(
      page.getByText('That code isn’t right. Check the most recent email and try again.', {
        exact: true
      })
    ).toBeVisible()
    await expect(page.locator('#code')).toBeEnabled()
    // The next guess is refused by the server as spent.
    await typeCode(page, wrongCode(code, 3))
    await expect(
      page.getByText('Too many incorrect codes. Request a new code to try again.')
    ).toBeVisible()
  })

  // PR #76 review 2, finding 2: a resend that did send a new code gets the new code's attempts.
  test('lets a resent new code be used after the old code’s misses', async ({ page }) => {
    await asClient(page)
    const email = uniqueEmail('fresh')
    // A member's code limits count per email and client, so a second client address can send a
    // new code within the minute.
    await page.goto('/login/?callbackUrl=%2Fabout%2F')
    await requestCodeInPage(page, email)
    await typeCode(page, await outboxCode(page, email))
    await page.waitForURL('**/about/')
    await page.locator('header').first().getByRole('button', { name: 'Account' }).click()
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await expectSignedOutHeader(page)

    await page.goto('/login/?callbackUrl=%2Fabout%2F')
    await requestCodeInPage(page, email)
    const oldCode = await outboxCode(page, email)
    await typeCode(page, wrongCode(oldCode, 0))
    await typeCode(page, wrongCode(oldCode, 1))
    await expect(page.getByText(/1 attempt left\.$/u)).toBeVisible()

    await asClient(page)
    await page.getByRole('button', { name: 'Send a new code' }).click()
    await expect.poll(() => outboxCode(page, email)).not.toBe(oldCode)
    const newCode = await outboxCode(page, email)
    // One miss on the new code: the old count would say it is spent, but it is not.
    await typeCode(
      page,
      wrongCode(newCode, 0) === oldCode ? wrongCode(newCode, 1) : wrongCode(newCode, 0)
    )
    await expect(
      page.getByText('That code isn’t right. Check the most recent email and try again.', {
        exact: true
      })
    ).toBeVisible()
    await expect(page.getByText('Too many incorrect codes')).toHaveCount(0)
    await typeCode(page, newCode)
    await page.waitForURL('**/about/')
  })

  // PR #76 review 2, finding 1: pasting or autofilling over a rejected code submits it.
  test('submits a pasted or autofilled code over the rejected one, never the rejected one again', async ({
    page
  }) => {
    await asClient(page)
    const email = uniqueEmail('paste')
    await page.goto('/login/?callbackUrl=%2Fabout%2F')
    await requestCodeInPage(page, email)
    const code = await outboxCode(page, email)
    await typeCode(page, wrongCode(code, 0))
    await expect(page.getByText(/2 attempts left\.$/u)).toBeVisible()
    // The rejected digits stay, and Verify will not send them again.
    await expect(page.getByRole('button', { name: 'Verify' })).toBeDisabled()
    // One value set over the six kept digits, as a paste or one-time-code autofill writes it.
    await page.locator('#code').fill(code)
    await page.waitForURL('**/about/')
  })

  // Owner bug: the code copied from the email as "482 913" did not paste into /login.
  test('signs in with a code pasted as "482 913", "482-913", " 482913\\n", or with a no-break space', async ({
    context,
    page
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    for (const [label, format] of COPIED_CODE_FORMATS) {
      await context.clearCookies()
      await asClient(page)
      const email = uniqueEmail('pasted')
      await page.goto('/login/')
      await requestCodeInPage(page, email)
      await pasteIntoCode(page, format(await outboxCode(page, email)))
      await expect(page.getByRole('heading', { name: 'You’re signed in' }), label).toBeVisible()
    }
  })

  // PR #82 review, finding 1: text with other digits before the code sent its first six digits.
  test('signs in with the one code in a pasted sentence, with a single guess', async ({
    context,
    page
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const code = await codeStep(page, 'sentence')
    const guesses = countGuesses(page)
    await pasteIntoCode(page, `It expires in 10 minutes. Code: ${code}`)
    await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible()
    expect(guesses.count).toBe(1)
  })

  for (const [label, ambiguous] of [
    [
      'two different codes',
      (code: string) => `Old code ${code === '111111' ? '222 222' : '111 111'}, new code ${code}`
    ],
    ['seven digits', (code: string) => `${code}1`],
    // PR #82 review 2: part of a phone number is not a code.
    ['a phone number', (_code: string) => 'Call 555 123 4567']
  ] as const) {
    test(`sends nothing for a paste with ${label}`, async ({ context, page }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const code = await codeStep(page, 'ambiguous')
      const guesses = countGuesses(page)
      await pasteIntoCode(page, ambiguous(code))
      // Give a submit time to start: none may.
      await page.waitForTimeout(750)
      expect(guesses.count).toBe(0)
      await expect(page.locator('#code')).toHaveValue('')
      await expect(page.getByText(/attempts? left/u)).toHaveCount(0)
      // The visitor can still paste the code itself.
      await pasteIntoCode(page, code)
      await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible()
      expect(guesses.count).toBe(1)
    })
  }

  // PR #82 review 2: seven autofilled digits were cut to their first six and sent.
  test('sends nothing for an autofilled value of seven digits', async ({ page }) => {
    const code = await codeStep(page, 'autofill7')
    const guesses = countGuesses(page)
    // The extra digit first, so its first six digits are a wrong code.
    await autofillCode(page, `${code === '000000' ? '1' : '0'}${code}`)
    await page.waitForTimeout(750)
    expect(guesses.count).toBe(0)
    await expect(page.locator('#code')).toHaveValue('')
    await expect(page.getByText(/attempts? left/u)).toHaveCount(0)
    // A six-digit autofill still signs in at once.
    await autofillCode(page, code)
    await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible()
    expect(guesses.count).toBe(1)
  })

  test('keeps only the digits of a code typed or autofilled with separators', async ({
    context,
    page
  }) => {
    for (const [label, format] of COPIED_CODE_FORMATS) {
      await context.clearCookies()
      await asClient(page)
      const email = uniqueEmail('typed')
      await page.goto('/login/')
      await requestCodeInPage(page, email)
      const code = await outboxCode(page, email)
      // Inserted as text, as a keyboard's clipboard suggestion does: one beforeinput event.
      await page.locator('#code').focus()
      await page.keyboard.insertText(format(code))
      await expect(page.getByRole('heading', { name: 'You’re signed in' }), label).toBeVisible()
    }
    // Set as one value, as autofill and password managers do.
    await context.clearCookies()
    await asClient(page)
    const email = uniqueEmail('autofill')
    await page.goto('/login/')
    await requestCodeInPage(page, email)
    const code = await outboxCode(page, email)
    await autofillCode(page, `${code.slice(0, 3)} ${code.slice(3)}`)
    await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible()
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
    // Sign-out reloads the page, and the signed-out header has no sign-in link of its own (#286):
    // open the menu again until the reloaded page's menu offers sign-in.
    await expect(async () => {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Open menu' }).click()
      await expect(
        page.getByRole('dialog').getByRole('link', { name: 'Sign up / Sign in' })
      ).toBeVisible({ timeout: 1000 })
    }).toPass()
  })
})
