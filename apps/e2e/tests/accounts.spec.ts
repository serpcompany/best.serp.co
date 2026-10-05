import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test
} from '@playwright/test'

/**
 * Accounts over HTTP against the local Worker (serpcompany/best.serp.co#60): the email code
 * sign-in with the local dev sender, the edge cache bypass for signed-in requests, and the admin
 * gate. Local only: staging and production have no dev sender (docs/ACCOUNTS.md).
 */

function unique(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** A fresh address per test, so repeated runs never share the per-email code limits. */
function uniqueEmail(label: string): string {
  return `e2e-${label}-${unique()}@example.com`
}

/** A documentation-range client IP per test; the local Worker uses it for the IP limits. */
function uniqueIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1
  return `198.18.${octet()}.${octet()}`
}

interface Client {
  headers: Record<string, string>
  request: APIRequestContext
}

function client(request: APIRequestContext, baseURL: string | undefined): Client {
  if (!baseURL) throw new Error('Playwright baseURL is required.')
  return {
    headers: { 'cf-connecting-ip': uniqueIp(), origin: new URL(baseURL).origin },
    request
  }
}

async function requestCode({ headers, request }: Client, email: string) {
  return request.post('/api/auth/email-otp/send-verification-otp', {
    data: { email, type: 'sign-in' },
    headers
  })
}

interface OutboxEntry {
  otp: string | null
  sentAt: number | null
}

async function outbox({ request }: Client, email: string): Promise<OutboxEntry> {
  const response = await request.get(`/api/auth/dev/otp-outbox?email=${encodeURIComponent(email)}`)
  expect(response.status()).toBe(200)
  return (await response.json()) as OutboxEntry
}

async function devOtp(account: Client, email: string): Promise<string> {
  const { otp } = await outbox(account, email)
  expect(otp).toMatch(/^\d{6}$/u)
  return otp as string
}

async function signIn(account: Client, email: string): Promise<void> {
  const requested = await requestCode(account, email)
  expect(requested.status(), await requested.text()).toBe(200)
  const otp = await devOtp(account, email)
  const signedIn = await account.request.post('/api/auth/sign-in/email-otp', {
    data: { email, otp },
    headers: account.headers
  })
  expect(signedIn.status(), await signedIn.text()).toBe(200)
}

test.describe('accounts', () => {
  test('requests a code, reads it from the dev sender, signs in, and signs out', async ({
    baseURL,
    request
  }) => {
    const account = client(request, baseURL)
    const email = uniqueEmail('flow')

    const requested = await requestCode(account, email)
    expect(requested.status()).toBe(200)
    expect(requested.headers()['x-edge-cache']).toBe('BYPASS')
    expect(requested.headers()['cache-control']).toContain('no-store')
    // Only this client, holding the code's binding cookie, may guess the code.
    expect(requested.headers()['set-cookie']).toMatch(
      /bsc_code_binding=[^;]+; Max-Age=900; Path=\/api\/auth; HttpOnly; SameSite=Strict/u
    )
    const otp = await devOtp(account, email)

    const signedIn = await request.post('/api/auth/sign-in/email-otp', {
      data: { email, otp },
      headers: account.headers
    })
    expect(signedIn.status()).toBe(200)
    expect(signedIn.headers()['set-cookie']).toContain('better-auth.session_token=')
    // The known-device cookie lets this browser always request the account's next code.
    expect(signedIn.headers()['set-cookie']).toMatch(
      /bsc_known_device=[^;]+; Max-Age=15552000; Path=\/api\/auth; HttpOnly; SameSite=Strict/u
    )

    const session = await request.get('/api/auth/get-session')
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email)

    const signedOut = await request.post('/api/auth/sign-out', {
      data: {},
      headers: account.headers
    })
    expect(signedOut.status()).toBe(200)
    expect(await (await request.get('/api/auth/get-session')).json()).toBeNull()
    // A used code cannot sign in again.
    const reused = await request.post('/api/auth/sign-in/email-otp', {
      data: { email, otp },
      headers: account.headers
    })
    expect(reused.status()).toBe(400)
  })

  test('answers a per-email limit like a sent code and keeps the code already sent', async ({
    baseURL,
    request
  }) => {
    const account = client(request, baseURL)
    const email = uniqueEmail('limit')
    expect((await requestCode(account, email)).status()).toBe(200)
    const first = await outbox(account, email)
    // A second code within the minute is not sent, but the answer does not say so.
    const again = await requestCode(account, email)
    expect(again.status()).toBe(200)
    expect(await again.json()).toEqual({ success: true })
    expect(await outbox(account, email)).toEqual(first)
    // The code the client already has still signs in.
    const signedIn = await request.post('/api/auth/sign-in/email-otp', {
      data: { email, otp: first.otp },
      headers: account.headers
    })
    expect(signedIn.status()).toBe(200)
  })

  test('limits each client with 429, whatever the email', async ({ baseURL, request }) => {
    const account = client(request, baseURL)
    for (let index = 0; index < 5; index += 1) {
      expect((await requestCode(account, uniqueEmail(`burst-${index}`))).status()).toBe(200)
    }
    const burst = await requestCode(account, uniqueEmail('burst-more'))
    expect(burst.status()).toBe(429)
    expect(Number(burst.headers()['retry-after'])).toBeGreaterThan(0)
  })

  test('refuses guesses from a client that did not request the code', async ({
    baseURL,
    request
  }) => {
    const owner = client(request, baseURL)
    const email = uniqueEmail('bound')
    expect((await requestCode(owner, email)).status()).toBe(200)
    const otp = await devOtp(owner, email)
    const stranger = await playwrightRequest.newContext({ baseURL })
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const guess = await stranger.post('/api/auth/sign-in/email-otp', {
          data: { email, otp: otp === '000000' ? '111111' : '000000' },
          headers: { 'cf-connecting-ip': uniqueIp(), origin: owner.headers.origin }
        })
        expect(guess.status()).toBe(400)
        expect(await guess.json()).toMatchObject({ code: 'INVALID_OTP' })
      }
    } finally {
      await stranger.dispose()
    }
    // The stranger's guesses never counted against the owner's code.
    const signedIn = await request.post('/api/auth/sign-in/email-otp', {
      data: { email, otp },
      headers: owner.headers
    })
    expect(signedIn.status()).toBe(200)
  })

  test('never serves a signed-in request from the edge cache or stores its response', async ({
    baseURL,
    request
  }) => {
    const anonymous = await playwrightRequest.newContext({ baseURL })
    try {
      const warmed = `/about/?accounts-cache-check=${unique()}`
      expect((await anonymous.get(warmed)).headers()['x-edge-cache']).toBe('MISS')
      await expect(async () => {
        expect((await anonymous.get(warmed)).headers()['x-edge-cache']).toBe('HIT')
      }).toPass({ timeout: 10_000 })

      await signIn(client(request, baseURL), uniqueEmail('cache'))
      const fresh = `/about/?accounts-cache-fresh=${unique()}`
      for (const path of [warmed, fresh, '/']) {
        const signedIn = await request.get(path)
        expect(signedIn.status(), path).toBe(200)
        expect(signedIn.headers()['x-edge-cache'], path).toBe('BYPASS')
      }
      // The signed-in request stored nothing: the first anonymous request is still a miss.
      expect((await anonymous.get(fresh)).headers()['x-edge-cache']).toBe('MISS')
      expect((await anonymous.get(warmed)).headers()['x-edge-cache']).toBe('HIT')
    } finally {
      await anonymous.dispose()
    }
  })
})

test.describe('admin gate', () => {
  const adminPages = ['/admin/', '/admin/not-a-page/', '/admin/submissions/x/preview/y/']
  const adminApi = ['/api/admin', '/api/admin/listings']

  test('answers 401 to anonymous visitors', async ({ request }) => {
    for (const path of [...adminPages, ...adminApi, '/ADMIN/']) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(401)
      expect(response.headers()['cache-control'], path).toContain('no-store')
    }
    const post = await request.post('/api/admin/listings', { data: {}, maxRedirects: 0 })
    expect(post.status()).toBe(401)
  })

  test('answers 403 to signed-in users who are not admins', async ({ baseURL, request }) => {
    await signIn(client(request, baseURL), uniqueEmail('member'))
    for (const path of adminPages) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(403)
    }
    for (const path of adminApi) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'admin_required' })
    }
  })

  test('admits the allowlisted owner', async ({ baseURL, request }) => {
    test.setTimeout(120_000)
    const account = client(request, baseURL)
    const email = 'devin@serp.co'
    const before = await outbox(account, email)
    const requested = await requestCode(account, email)
    expect(requested.status(), await requested.text()).toBe(200)
    // An admin's code limits count per client address (fresh per test), under an email-wide
    // hourly ceiling every run shares. A denied request answers 200 like a sent one, so the
    // outbox tells whether a code went out: skip rather than wait if a busy hour reached it.
    const after = await outbox(account, email)
    test.skip(
      after.sentAt === null || after.sentAt === before.sentAt,
      'devin@serp.co hourly code limit reached; retry within the hour'
    )
    const otp = await devOtp(account, email)
    const signedIn = await request.post('/api/auth/sign-in/email-otp', {
      data: { email, otp },
      headers: account.headers
    })
    expect(signedIn.status()).toBe(200)

    // The admin stub renders nothing: 204 for an admin (#70 approves every screen first).
    const stub = await request.get('/admin/')
    expect(stub.status()).toBe(204)
    expect(await stub.text()).toBe('')
    expect((await request.get('/api/admin/listings')).status()).toBe(404)
    expect((await request.get('/admin/not-a-page/')).status()).toBe(404)

    // Admin writes need this site's Origin, not just a same-site cookie.
    const foreign = await request.post('/api/admin/listings', {
      data: {},
      headers: { origin: 'https://other.serp.co' }
    })
    expect(foreign.status()).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: 'origin_rejected' })
    const missing = await request.delete('/api/admin/listings')
    expect(missing.status()).toBe(403)
    const trusted = await request.post('/api/admin/listings', {
      data: {},
      headers: { origin: account.headers.origin }
    })
    expect(trusted.status()).toBe(404)
  })
})
