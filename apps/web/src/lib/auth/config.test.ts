/**
 * The real Better Auth configuration (`config.ts`) against SQLite with the checked-in
 * migrations: request a code, sign in, read the session, sign out; abuse limits and the
 * uniform answers of per-email limits; the attempt cap and the code binding; roles from the
 * allowlist; and the fail-closed staging and production behavior.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthOperations } from '@/db/auth'
import { createDatabase } from '@/db/client'
import { SqliteD1 } from '@/db/test-support'
import {
  ALLOWED_AUTH_ENDPOINTS,
  type Auth,
  createAuth,
  DEV_AUTH_ENDPOINTS,
  DEV_OTP_OUTBOX_PATH,
  MAX_NAME_LENGTH
} from './config'
import { AUTH_COOKIE_PREFIX, hasSessionCookie } from './cookies'
import { authorizeAdmin } from './guards'
import {
  clearDevOtpOutbox,
  createDevOtpSender,
  type OtpMessage,
  type OtpSender,
  selectOtpSender,
  unavailableOtpSender
} from './otp-sender'
import { OTP_REQUEST_LIMITS } from './rate-limits'
import { resolveAuthSettings } from './settings'

const LOCAL_ORIGIN = 'http://localhost:8978'
const STAGING_ORIGIN = 'https://best-serp-co-staging.serpcompany.workers.dev'
const SECRET = 'test-secret-'.repeat(4)
const SEND = '/email-otp/send-verification-otp'
const SIGN_IN = '/sign-in/email-otp'

/** One client: an address and the cookies its responses set (a minimal cookie jar). */
class Browser {
  readonly cookies = new Map<string, string>()

  constructor(readonly ip: string) {}

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (!value || attributes.some(part => /^\s*max-age=0$/iu.test(part))) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, value)
      }
    }
  }

  /** The `name=value` pair of the first cookie whose name matches. */
  pair(name: RegExp): string {
    for (const [key, value] of this.cookies) if (name.test(key)) return `${key}=${value}`
    throw new Error(`No cookie matches ${name}.`)
  }
}

interface Harness {
  auth: Auth
  call(path: string, init?: CallInit): Promise<Response>
  operations: ReturnType<typeof createAuthOperations>
  origin: string
  /** Every code the sender delivered, in order. */
  sent: OtpMessage[]
  sqlite: SqliteD1
}

interface CallInit {
  body?: unknown
  /** Sends this client's cookies and address, and keeps the cookies its response sets. */
  browser?: Browser
  /** Extra cookies, sent before the browser's own. */
  cookie?: string
  ip?: string
  method?: string
  origin?: string | null
}

/** The dev sender, recording every delivery. */
function recordingDevSender(sent: OtpMessage[]): OtpSender {
  const dev = createDevOtpSender(() => {})
  return {
    kind: dev.kind,
    async send(message) {
      sent.push(message)
      await dev.send(message)
    }
  }
}

function harness(options: { environment?: 'local' | 'staging'; sender?: OtpSender } = {}): Harness {
  const environment = options.environment ?? 'local'
  const sqlite = new SqliteD1()
  const client = createDatabase(sqlite.asD1Database())
  const operations = createAuthOperations({ client, rateLimitKey: SECRET })
  const settings = resolveAuthSettings(
    environment === 'local'
      ? { BETTER_AUTH_SECRET: SECRET, D1_RUNTIME_ENV: 'local', SITE_ENVIRONMENT: 'local' }
      : {
          BETTER_AUTH_SECRET: SECRET,
          BETTER_AUTH_TRUSTED_ORIGINS: STAGING_ORIGIN,
          BETTER_AUTH_URL: STAGING_ORIGIN,
          D1_RUNTIME_ENV: 'staging',
          SITE_ENVIRONMENT: 'staging'
        }
  )
  const origin = environment === 'local' ? LOCAL_ORIGIN : STAGING_ORIGIN
  const sent: OtpMessage[] = []
  const auth = createAuth({
    client,
    operations,
    sender: options.sender ?? recordingDevSender(sent),
    settings
  })
  return {
    auth,
    async call(path, init = {}) {
      const headers = new Headers({
        'cf-connecting-ip': init.browser?.ip ?? init.ip ?? '203.0.113.10'
      })
      if (init.origin !== null) headers.set('origin', init.origin ?? origin)
      const cookie = [init.cookie, init.browser?.header()].filter(Boolean).join('; ')
      if (cookie) headers.set('cookie', cookie)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      const response = await auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          headers,
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST')
        })
      )
      init.browser?.store(response)
      return response
    },
    operations,
    origin,
    sent,
    sqlite
  }
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map(header => header.split(';')[0] ?? '')
    .find(pair => hasSessionCookie(pair))
  if (!cookie) throw new Error('No session cookie was set.')
  return cookie
}

/** Requests a code from `browser`; returns the response and whether a code was sent. */
async function sendCode(
  h: Harness,
  email: string,
  browser: Browser
): Promise<{ response: Response; sent: boolean }> {
  const before = h.sent.length
  const response = await h.call(SEND, { body: { email, type: 'sign-in' }, browser })
  return { response, sent: h.sent.length > before }
}

/** Requests a code from `browser`, expects it to be sent, and returns it. */
async function requestCode(h: Harness, email: string, browser: Browser): Promise<string> {
  const { response, sent } = await sendCode(h, email, browser)
  expect(response.status, await response.clone().text()).toBe(200)
  expect(sent, `a code was sent to ${email}`).toBe(true)
  return h.sent.at(-1)?.otp ?? ''
}

async function guess(h: Harness, email: string, otp: string, browser: Browser) {
  return h.call(SIGN_IN, { body: { email, otp }, browser })
}

/** Signs in from `browser`; returns the session and known-device cookies, as `name=value`. */
async function signInWithDevice(
  h: Harness,
  email: string,
  browser: Browser
): Promise<{ device: string; session: string }> {
  const otp = await requestCode(h, email, browser)
  const response = await guess(h, email, otp, browser)
  expect(response.status, await response.clone().text()).toBe(200)
  return { device: browser.pair(/bsc_known_device$/u), session: sessionCookie(response) }
}

async function signIn(h: Harness, email: string, browser: Browser): Promise<string> {
  return (await signInWithDevice(h, email, browser)).session
}

/** A response's status, body, and `Set-Cookie` headers with their values masked. */
async function shape(response: Response) {
  return {
    body: await response.clone().text(),
    cookies: response.headers.getSetCookie().map(header => header.replace(/=[^;]*/u, '=<value>')),
    status: response.status
  }
}

beforeEach(() => clearDevOtpOutbox())

describe('email OTP sign-in', () => {
  it('requests a code, signs in, reads the session, and signs out', async () => {
    const h = harness()
    const browser = new Browser('203.0.113.10')
    const otp = await requestCode(h, 'Visitor@Example.com', browser)
    // The local outbox returns the code to HTTP tests.
    const outbox = await h.call(`${DEV_OTP_OUTBOX_PATH}?email=visitor%40example.com`)
    expect(await outbox.json()).toEqual({ otp, sentAt: expect.any(Number) })
    // Only a hash of the code is stored.
    const stored = h.sqlite.database.prepare('SELECT identifier, value FROM verification').all()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(otp)

    const signedIn = await guess(h, 'visitor@example.com', otp, browser)
    expect(signedIn.status).toBe(200)
    const cookie = sessionCookie(signedIn)
    expect(cookie.startsWith(`${AUTH_COOKIE_PREFIX}.session_token=`)).toBe(true)
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM verification').get()).toEqual({
      n: 0
    })

    const user = h.sqlite.database
      .prepare('SELECT email, email_verified, role FROM users')
      .get() as Record<string, unknown>
    expect({ ...user }).toEqual({ email: 'visitor@example.com', email_verified: 1, role: 'user' })

    const session = await h.call('/get-session', { cookie })
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(
      'visitor@example.com'
    )

    const signedOut = await h.call('/sign-out', { body: {}, cookie })
    expect(signedOut.status).toBe(200)
    expect(await (await h.call('/get-session', { cookie })).json()).toBeNull()
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })

  it('caps guesses per code and rejects reuse', async () => {
    const h = harness()
    const browser = new Browser('203.0.113.11')
    const email = 'guesser@example.com'
    const otp = await requestCode(h, email, browser)
    const wrong = otp === '000000' ? '111111' : '000000'
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await guess(h, email, wrong, browser)
      expect(response.status, `attempt ${attempt}`).toBe(400)
    }
    const locked = await guess(h, email, otp, browser)
    expect(locked.status).toBe(403)
    expect(((await locked.json()) as { code: string }).code).toBe('TOO_MANY_ATTEMPTS')
    // The code is gone; even the right one no longer works.
    expect((await guess(h, email, otp, browser)).status).toBe(400)
  })

  // Owner bug: a code copied from the email as "482 913" did not sign in.
  it('accepts a code copied with spaces, dashes, line breaks, or invisible characters', async () => {
    const h = harness()
    const formats: Array<(code: string) => string> = [
      code => `${code.slice(0, 3)} ${code.slice(3)}`,
      code => `${code.slice(0, 3)}-${code.slice(3)}`,
      code => ` ${code}\n`,
      code => `${code.slice(0, 3)}\u00a0${code.slice(3)}`,
      code => `\u200b${code.slice(0, 3)}\u200b${code.slice(3)}\ufeff`
    ]
    for (const [index, format] of formats.entries()) {
      const browser = new Browser(`192.0.2.${70 + index}`)
      const email = `pasted-${index}@example.com`
      const otp = await requestCode(h, email, browser)
      const response = await guess(h, email, format(otp), browser)
      expect(response.status, JSON.stringify(format(otp))).toBe(200)
    }
    // Normalizing never makes a wrong code right, and a formatted wrong code counts as a guess.
    const browser = new Browser('192.0.2.79')
    const email = 'pasted-wrong@example.com'
    const otp = await requestCode(h, email, browser)
    const wrong = otp === '000000' ? '111 111' : '000 000'
    const refused = await guess(h, email, wrong, browser)
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { code: string }).code).toBe('INVALID_OTP')
    expect((await guess(h, email, `${otp.slice(0, 3)} ${otp.slice(3)}`, browser)).status).toBe(200)
  })

  it('limits each client to a few code requests, with 429 whatever the email', async () => {
    const h = harness()
    const browser = new Browser('198.51.100.3')
    for (let index = 0; index < OTP_REQUEST_LIMITS.ipBurst.max; index += 1) {
      await requestCode(h, `person-${index}@example.com`, browser)
    }
    const burst = await sendCode(h, 'one-more@example.com', browser)
    expect(burst.response.status).toBe(429)
    expect(burst.sent).toBe(false)
    expect(Number(burst.response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await burst.response.json()) as { code: string }).code).toBe('RATE_LIMITED')
    const rows = h.sqlite.database.prepare('SELECT count(*) AS n FROM auth_rate_limit_hits').get()
    expect(Number((rows as { n: number }).n)).toBeGreaterThan(0)
  })

  // The deploy HTTP gates send this request after every deploy (#161), so it must get the same
  // answer however often it repeats, and never count toward a limit or send a code.
  it('answers an empty email 400 INVALID_EMAIL every time, without counting or sending', async () => {
    const h = harness()
    const browser = new Browser('198.51.100.9')
    const tries = OTP_REQUEST_LIMITS.ipBurst.max + 3
    for (let index = 0; index < tries; index += 1) {
      const response = await h.call(SEND, { body: { email: '', type: 'sign-in' }, browser })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { code: string }).code).toBe('INVALID_EMAIL')
    }
    expect(h.sent).toEqual([])
    const rows = h.sqlite.database.prepare('SELECT count(*) AS n FROM auth_rate_limit_hits').get()
    expect(Number((rows as { n: number }).n)).toBe(0)
  })

  it('groups an IPv6 /64 into one client for the per-client limits', async () => {
    const h = harness()
    for (let index = 1; index <= OTP_REQUEST_LIMITS.ipBurst.max; index += 1) {
      await requestCode(h, `v6-${index}@example.com`, new Browser(`2001:db8:77:77::${index}`))
    }
    const sameSubnet = await sendCode(
      h,
      'v6-more@example.com',
      new Browser('2001:db8:77:77:ffff::1')
    )
    expect(sameSubnet.response.status).toBe(429)
    await requestCode(h, 'v6-other@example.com', new Browser('2001:db8:77:78::1'))
  })

  // Review round 3, finding 3: limit decisions never reveal whether an email has an account.
  it('answers a per-email limit exactly like a sent code, and sends nothing', async () => {
    const h = harness()
    await signIn(h, 'member@example.com', new Browser('192.0.2.10'))
    const shapes: Record<string, Awaited<ReturnType<typeof shape>>[]> = {}
    const outcomes: Record<string, boolean[]> = {}
    // The reviewer's probe: two requests from two clients within a minute.
    for (const email of ['member@example.com', 'new-person@example.com']) {
      shapes[email] = []
      outcomes[email] = []
      for (const ip of ['198.51.100.21', '198.51.100.22']) {
        const { response, sent } = await sendCode(h, email, new Browser(ip))
        shapes[email]?.push(await shape(response))
        outcomes[email]?.push(sent)
      }
    }
    // A member's code goes to each client; a new email's second request sends nothing...
    expect(outcomes).toEqual({
      'member@example.com': [true, true],
      'new-person@example.com': [true, false]
    })
    // ...but every answer looks the same: 200, the same body, and a binding cookie.
    const expected = {
      body: '{"success":true}',
      cookies: ['bsc_code_binding=<value>; Max-Age=900; Path=/api/auth; HttpOnly; SameSite=Strict'],
      status: 200
    }
    expect(shapes).toEqual({
      'member@example.com': [expected, expected],
      'new-person@example.com': [expected, expected]
    })
  })

  it('answers the same once the site-wide ceiling is full, while members still get codes', async () => {
    const h = harness()
    const member = new Browser('192.0.2.50')
    const { device } = await signInWithDevice(h, 'member@example.com', member)

    // 60 /64s x 5 requests for fresh addresses fill the site-wide ceiling (the member's own
    // first sign-in, a new email then, used one slot).
    let sent = 0
    for (let subnet = 1; subnet <= 60; subnet += 1) {
      for (let request = 1; request <= 5; request += 1) {
        const outcome = await sendCode(
          h,
          `flood-${subnet}-${request}@example.com`,
          new Browser(`2001:db8:f00d:${subnet.toString(16)}::${request}`)
        )
        expect(outcome.response.status).toBe(200)
        if (outcome.sent) sent += 1
      }
    }
    expect(sent).toBe(OTP_REQUEST_LIMITS.siteHourly.max - 1)
    const newcomer = await sendCode(h, 'newcomer@example.com', new Browser('192.0.2.60'))
    expect(newcomer.response.status).toBe(200)
    expect(newcomer.sent).toBe(false)

    // Existing accounts are outside the site-wide ceiling, with or without their device.
    const withDevice = await h.call(SEND, {
      body: { email: 'member@example.com', type: 'sign-in' },
      cookie: device,
      ip: '192.0.2.61'
    })
    expect(withDevice.status).toBe(200)
    await requestCode(h, 'member@example.com', new Browser('192.0.2.62'))
    expect(h.sent.filter(message => message.email === 'member@example.com')).toHaveLength(3)
  })

  it('keeps the code a browser holds when its repeat request is not sent', async () => {
    const h = harness()
    const browser = new Browser('198.51.100.30')
    const email = 'patient@example.com'
    const otp = await requestCode(h, email, browser)
    // A second request within the minute is answered but not sent; the first code still works.
    const repeat = await sendCode(h, email, browser)
    expect(repeat.response.status).toBe(200)
    expect(repeat.sent).toBe(false)
    expect((await guess(h, email, otp, browser)).status).toBe(200)
  })

  // Review round 3, finding 1: guesses from other clients cannot void a code.
  it('lets only the browser that requested the latest code guess it', async () => {
    const h = harness()
    const owner = 'devin@serp.co'
    const ownerBrowser = new Browser('2001:db8:aa:1::1')
    await signInWithDevice(h, owner, ownerBrowser)
    const otp = await requestCode(h, owner, ownerBrowser)
    const wrong = otp === '000000' ? '111111' : '000000'

    // The reviewer's probe: three clients each send one wrong guess...
    const foreign: Response[] = []
    for (const ip of ['198.51.100.41', '198.51.100.42', '198.51.100.43']) {
      foreign.push(await guess(h, owner, wrong, new Browser(ip)))
    }
    // ...and even the right code from a client that did not request it.
    foreign.push(await guess(h, owner, otp, new Browser('198.51.100.44')))
    const attempts = () =>
      String(
        (h.sqlite.database.prepare('SELECT value FROM verification').get() as { value: string })
          .value
      ).split(':')[1]
    expect(attempts()).toBe('0')

    // Each refusal is exactly Better Auth's answer to a wrong code.
    const ownWrong = await guess(h, owner, wrong, ownerBrowser)
    expect(attempts()).toBe('1')
    const wrongShape = await shape(ownWrong)
    expect(wrongShape).toEqual({
      body: '{"message":"Invalid OTP","code":"INVALID_OTP"}',
      cookies: [],
      status: 400
    })
    for (const response of foreign) expect(await shape(response)).toEqual(wrongShape)

    // The owner's code still works.
    const signedIn = await guess(h, owner, otp, ownerBrowser)
    expect(signedIn.status).toBe(200)
    // The used code's binding is cleared with the sign-in.
    expect(signedIn.headers.getSetCookie()).toContain(
      'bsc_code_binding=; Max-Age=0; Path=/api/auth; HttpOnly; SameSite=Strict'
    )
  })

  it('lets a client burn only a code it requested itself, never a newer one', async () => {
    const h = harness()
    const owner = 'victim@example.com'
    const ownerBrowser = new Browser('192.0.2.70')
    await signIn(h, owner, ownerBrowser)
    // The attacker requests a code for the owner's email (it goes to the owner's inbox)...
    const attacker = new Browser('198.51.100.50')
    expect((await sendCode(h, owner, attacker)).sent).toBe(true)
    // ...then the owner requests a newer one, which replaces it. (Codes are ordered by their
    // millisecond creation time, as Better Auth orders them.)
    await new Promise(resolve => setTimeout(resolve, 5))
    const otp = await requestCode(h, owner, ownerBrowser)
    const wrong = otp === '000000' ? '111111' : '000000'
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await guess(h, owner, wrong, attacker)).status).toBe(400)
    }
    expect((await guess(h, owner, otp, ownerBrowser)).status).toBe(200)
  })

  // Review round 2, finding 1: an attacker cannot stop a legitimate user from getting a code.
  it('cannot lock out an owner with a known device from 20 /64s', async () => {
    const h = harness()
    const owner = 'devin@serp.co'
    const ownerBrowser = new Browser('2001:db8:aa:1::1')
    const { device } = await signInWithDevice(h, owner, ownerBrowser)

    // One request each from 20 /64s spends the owner's email-wide ceiling.
    let sent = 0
    for (let subnet = 1; subnet <= 20; subnet += 1) {
      const outcome = await sendCode(
        h,
        owner,
        new Browser(`2001:db8:bad:${subnet.toString(16)}::1`)
      )
      expect(outcome.response.status).toBe(200)
      if (outcome.sent) sent += 1
    }
    expect(sent).toBeGreaterThanOrEqual(OTP_REQUEST_LIMITS.memberEmailHourly.max - 1)
    // Without the cookie the inbox ceiling holds, from any address (answered, not sent).
    for (const ip of ['2001:db8:bad:ff::1', '2001:db8:cafe:1::1']) {
      const stranger = await sendCode(h, owner, new Browser(ip))
      expect(stranger.response.status, ip).toBe(200)
      expect(stranger.sent, ip).toBe(false)
    }
    // ...but the owner's own browser still gets a code, from a new address too.
    await requestCode(h, owner, ownerBrowser)
    const travelling = new Browser('2001:db8:cafe:2::1')
    travelling.cookies.set('bsc_known_device', device.split('=')[1] ?? '')
    await requestCode(h, owner, travelling)
    // A cookie planted by a sibling site, sent first, does not hide the real one (finding 5).
    const planted = new Browser('2001:db8:cafe:4::1')
    planted.cookies.set('bsc_known_device', device.split('=')[1] ?? '')
    const withPlanted = await h.call(SEND, {
      body: { email: owner, type: 'sign-in' },
      browser: planted,
      cookie: 'bsc_known_device=planted.value'
    })
    expect(withPlanted.status).toBe(200)
    expect(h.sent.at(-1)?.email).toBe(owner)
    // Another account's device cookie does not help.
    const other = new Browser('192.0.2.40')
    const { device: otherDevice } = await signInWithDevice(h, 'other@example.com', other)
    const before = h.sent.length
    const borrowed = await h.call(SEND, {
      body: { email: owner, type: 'sign-in' },
      cookie: otherDevice,
      ip: '2001:db8:cafe:3::1'
    })
    expect(borrowed.status).toBe(200)
    expect(h.sent.length).toBe(before)
  })

  // Review round 3, finding 4: a stolen known-device cookie does not remove the inbox cap.
  it('caps a known-device cookie at its own 10 codes an hour across clients', async () => {
    const h = harness()
    const owner = 'devin@serp.co'
    const { device } = await signInWithDevice(h, owner, new Browser('192.0.2.80'))
    const before = h.sent.length
    for (let subnet = 1; subnet <= 30; subnet += 1) {
      const response = await h.call(SEND, {
        body: { email: owner, type: 'sign-in' },
        cookie: device,
        ip: `2001:db8:5:${subnet.toString(16)}::1`
      })
      expect(response.status).toBe(200)
    }
    expect(h.sent.length - before).toBe(OTP_REQUEST_LIMITS.knownDeviceEmailHourly.max)
    // Clients without the cookie keep their own ceiling, which the cookie did not spend.
    await requestCode(h, owner, new Browser('198.51.100.90'))
  })

  it('sets the binding and known-device cookies, scoped to /api/auth', async () => {
    const h = harness()
    const browser = new Browser('203.0.113.12')
    const email = 'device@example.com'
    const requested = await h.call(SEND, { body: { email, type: 'sign-in' }, browser })
    expect(requested.headers.getSetCookie()).toEqual([
      expect.stringMatching(
        /^bsc_code_binding=\d+\.[\w-]{43}; Max-Age=900; Path=\/api\/auth; HttpOnly; SameSite=Strict$/u
      )
    ])
    const otp = h.sent.at(-1)?.otp ?? ''
    // A failed sign-in sets nothing.
    const failed = await guess(h, email, otp === '000000' ? '111111' : '000000', browser)
    expect(failed.headers.getSetCookie()).toEqual([])
    const response = await guess(h, email, otp, browser)
    expect(response.status).toBe(200)
    const header = response.headers
      .getSetCookie()
      .find(value => value.startsWith('bsc_known_device='))
    expect(header).toBeDefined()
    expect(header).toContain('Path=/api/auth')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain(`Max-Age=${180 * 24 * 60 * 60}`)
  })

  it('serves only the allowlisted endpoints; every other Better Auth route is 404', async () => {
    const h = harness()
    const allowed = new Set(
      [...ALLOWED_AUTH_ENDPOINTS, ...DEV_AUTH_ENDPOINTS].map(e => `${e.method} ${e.path}`)
    )
    // Every allowlisted endpoint exists, so the list cannot drift from Better Auth.
    const registered = new Set(
      h.auth.routes.flatMap(route => route.methods.map(method => `${method} ${route.path}`))
    )
    for (const endpoint of allowed) expect(registered, endpoint).toContain(endpoint)
    expect(h.auth.routes.length).toBeGreaterThan(20)

    let refused = 0
    for (const route of h.auth.routes) {
      const path = route.path.replace(/:[A-Za-z]+/gu, 'x')
      for (const method of route.methods) {
        if (allowed.has(`${method} ${route.path}`)) continue
        const response = await h.call(path, {
          body: method === 'GET' ? undefined : { email: 'x@example.com', password: 'p4ssword!' },
          method
        })
        expect(response.status, `${method} ${route.path}`).toBe(404)
        refused += 1
      }
    }
    expect(refused).toBeGreaterThan(20)
    for (const path of ['/update-user', '/delete-user', '/verify-password', '/sign-in/social']) {
      expect((await h.call(path, { body: { role: 'admin' } })).status, path).toBe(404)
    }
    // Variants of an allowlisted path are not allowlisted.
    for (const path of ['/get-session/', '/GET-SESSION', '/get-session%2F']) {
      expect((await h.call(path)).status, path).toBe(404)
    }
    expect((await h.call('/sign-out', { method: 'GET' })).status).toBe(404)

    const reset = await h.call(SEND, {
      body: { email: 'reset@example.com', type: 'forget-password' }
    })
    expect(reset.status).toBe(400)
  })

  it('lets a first sign-in set a short name but never an image', async () => {
    const h = harness()
    const browser = new Browser('203.0.113.13')
    const email = 'named@example.com'
    const otp = await requestCode(h, email, browser)
    for (const body of [
      { email, image: 'javascript:alert(1)', otp },
      { email, name: 'x'.repeat(MAX_NAME_LENGTH + 1), otp },
      { email, name: 42, otp }
    ]) {
      const refused = await h.call(SIGN_IN, { body, browser })
      expect(refused.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    const accepted = await h.call(SIGN_IN, { body: { email, name: 'Named', otp }, browser })
    expect(accepted.status).toBe(200)
    expect(
      h.sqlite.database.prepare('SELECT name, image FROM users WHERE email = ?').get(email)
    ).toEqual({ image: null, name: 'Named' })
  })

  it('rejects cross-site requests that carry the session cookie', async () => {
    const h = harness()
    const cookie = await signIn(h, 'csrf@example.com', new Browser('203.0.113.14'))
    for (const origin of ['https://evil.example', null]) {
      const forged = await h.call('/sign-out', { body: {}, cookie, origin })
      expect(forged.status, String(origin)).toBe(403)
    }
    expect(await (await h.call('/get-session', { cookie })).json()).not.toBeNull()
  })
})

describe('roles from the admin allowlist', () => {
  const guard = (h: Harness, cookie?: string) =>
    authorizeAdmin({
      getAdminStatus: userId => h.operations.getAdminStatus(userId),
      getSession: async () => {
        const result = await h.auth.api.getSession({
          headers: new Headers({ host: new URL(h.origin).host, ...(cookie ? { cookie } : {}) })
        })
        return result
          ? {
              session: result.session,
              user: { ...result.user, role: String(result.user.role ?? '') }
            }
          : null
      }
    })

  it('makes the seeded owner an admin and everyone else a user', async () => {
    const h = harness()
    const ownerCookie = await signIn(h, 'devin@serp.co', new Browser('192.0.2.1'))
    const visitorCookie = await signIn(h, 'visitor@example.com', new Browser('192.0.2.2'))
    const roles = h.sqlite.database.prepare('SELECT email, role FROM users ORDER BY email').all()
    expect(roles.map(row => ({ ...row }))).toEqual([
      { email: 'devin@serp.co', role: 'admin' },
      { email: 'visitor@example.com', role: 'user' }
    ])

    expect(await guard(h, ownerCookie)).toMatchObject({ ok: true })
    expect(await guard(h, visitorCookie)).toMatchObject({ status: 403 })
    expect(await guard(h)).toMatchObject({ status: 401 })

    // Removing the owner from the allowlist revokes admin access on the next request.
    h.sqlite.database.prepare('DELETE FROM admin_allowlist').run()
    expect(await guard(h, ownerCookie)).toMatchObject({ status: 403 })
  })

  // #78: revocation must not depend on the allowlist becoming empty.
  it('revokes one admin on the next request while another admin stays allowlisted', async () => {
    const h = harness()
    h.sqlite.database
      .prepare(
        "INSERT INTO admin_allowlist (email, added_by) VALUES ('second@example.com', 'test')"
      )
      .run()
    const ownerCookie = await signIn(h, 'devin@serp.co', new Browser('192.0.2.4'))
    const secondCookie = await signIn(h, 'second@example.com', new Browser('192.0.2.5'))
    const visitorCookie = await signIn(h, 'visitor@example.com', new Browser('192.0.2.6'))
    expect(await guard(h, ownerCookie)).toMatchObject({ ok: true })
    expect(await guard(h, secondCookie)).toMatchObject({ ok: true })
    expect(await guard(h, visitorCookie)).toMatchObject({ reason: 'admin_required', status: 403 })

    h.sqlite.database.prepare("DELETE FROM admin_allowlist WHERE email = 'devin@serp.co'").run()
    // Same session, role still `admin` in D1 until the next sign-in: the live check decides.
    expect(
      h.sqlite.database.prepare("SELECT role FROM users WHERE email = 'devin@serp.co'").get()
    ).toEqual({ role: 'admin' })
    expect(await guard(h, ownerCookie)).toMatchObject({ reason: 'admin_required', status: 403 })
    expect(await guard(h, secondCookie)).toMatchObject({ ok: true })
    expect(await guard(h, visitorCookie)).toMatchObject({ reason: 'admin_required', status: 403 })
  })

  it('never lets a user choose their own role', async () => {
    const h = harness()
    const browser = new Browser('192.0.2.3')
    const email = 'climber@example.com'
    const otp = await requestCode(h, email, browser)
    const signedIn = await h.call(SIGN_IN, { body: { email, otp, role: 'admin' }, browser })
    expect(signedIn.status).toBe(200)
    const cookie = sessionCookie(signedIn)
    const row = h.sqlite.database.prepare('SELECT role FROM users WHERE email = ?').get(email)
    expect(row).toEqual({ role: 'user' })
    // Profile updates are not served at all, so no field (role included) can change later.
    const update = await h.call('/update-user', { body: { role: 'admin' }, cookie })
    expect(update.status).toBe(404)
    expect(h.sqlite.database.prepare('SELECT role FROM users WHERE email = ?').get(email)).toEqual({
      role: 'user'
    })
  })
})

describe('staging and production', () => {
  it('answers 503 for a code until the sign-in email exists, and exposes no outbox', async () => {
    const h = harness({ environment: 'staging', sender: unavailableOtpSender })
    const response = await h.call(SEND, { body: { email: 'devin@serp.co', type: 'sign-in' } })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('OTP_DELIVERY_UNAVAILABLE')
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM verification').get()).toEqual({
      n: 0
    })
    expect((await h.call(`${DEV_OTP_OUTBOX_PATH}?email=devin@serp.co`)).status).toBe(404)
  })

  it('sends the code as the sign-in-code email once that template is registered', async () => {
    const enqueued: unknown[] = []
    const email = {
      deliveryConfigured: async () => true,
      async enqueue(request: unknown) {
        enqueued.push(request)
      },
      eventKey: () => 'sign-in-code:00000000-0000-4000-8000-000000000001'
    }
    const unregistered = harness({
      environment: 'staging',
      sender: selectOtpSender('staging', { ...email, templateRegistered: false })
    })
    const refused = await unregistered.call(SEND, {
      body: { email: 'devin@serp.co', type: 'sign-in' }
    })
    expect(refused.status).toBe(503)

    const h = harness({
      environment: 'staging',
      sender: selectOtpSender('staging', { ...email, templateRegistered: true })
    })
    const browser = new Browser('203.0.113.20')
    const requested = await h.call(SEND, {
      body: { email: 'Devin@Serp.co', type: 'sign-in' },
      browser
    })
    expect(requested.status).toBe(200)
    expect(enqueued).toEqual([
      {
        eventKey: 'sign-in-code:00000000-0000-4000-8000-000000000001',
        input: { code: expect.stringMatching(/^\d{6}$/u), expiresInMinutes: 10 },
        to: 'devin@serp.co'
      }
    ])
    const { code } = (enqueued[0] as { input: { code: string } }).input
    expect((await guess(h, 'devin@serp.co', code, browser)).status).toBe(200)
  })

  it('answers 503 and creates no code while the Worker cannot deliver email', async () => {
    const enqueue = async () => {
      throw new Error('a code must not be sent')
    }
    const h = harness({
      environment: 'staging',
      sender: selectOtpSender('staging', {
        deliveryConfigured: async () => false,
        enqueue,
        eventKey: () => 'sign-in-code:00000000-0000-4000-8000-000000000001',
        templateRegistered: true
      })
    })
    const response = await h.call(SEND, { body: { email: 'devin@serp.co', type: 'sign-in' } })
    expect(response.status).toBe(503)
    expect(((await response.json()) as { code: string }).code).toBe('OTP_DELIVERY_UNAVAILABLE')
    expect(h.sqlite.database.prepare('SELECT count(*) AS n FROM verification').get()).toEqual({
      n: 0
    })
    // Refused before any limit is counted, so fixing the configuration restores sign-in at once.
    expect(
      h.sqlite.database.prepare('SELECT count(*) AS n FROM auth_rate_limit_hits').get()
    ).toEqual({ n: 0 })
  })

  it('uses __Secure- cookies on https origins', async () => {
    const sent: OtpMessage[] = []
    const h = harness({
      environment: 'staging',
      sender: {
        kind: 'test',
        async send(message) {
          sent.push(message)
        }
      }
    })
    const browser = new Browser('203.0.113.21')
    const email = 'staging@example.com'
    const requested = await h.call(SEND, { body: { email, type: 'sign-in' }, browser })
    expect(requested.status).toBe(200)
    expect(requested.headers.getSetCookie()).toEqual([
      expect.stringMatching(
        /^__Secure-bsc_code_binding=[^;]+; Max-Age=900; Path=\/api\/auth; HttpOnly; Secure; SameSite=Strict$/u
      )
    ])
    const otp = sent[0]?.otp ?? ''
    expect(otp).toMatch(/^\d{6}$/u)
    const response = await guess(h, email, otp, browser)
    expect(response.status).toBe(200)
    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain(`__Secure-${AUTH_COOKIE_PREFIX}.session_token=`)
    expect(setCookie).toMatch(/HttpOnly/iu)
    expect(setCookie).toMatch(/Secure/u)
    expect(setCookie).toMatch(/SameSite=Lax/iu)
    expect(setCookie).toMatch(
      /__Secure-bsc_known_device=[^;]+; Max-Age=\d+; Path=\/api\/auth; HttpOnly; SameSite=Strict; Secure/u
    )
  })

  it('refuses the dev sender outside local', () => {
    const sqlite = new SqliteD1()
    const client = createDatabase(sqlite.asD1Database())
    expect(() =>
      createAuth({
        client,
        operations: createAuthOperations({ client, rateLimitKey: SECRET }),
        sender: createDevOtpSender(() => {}),
        settings: resolveAuthSettings({
          BETTER_AUTH_SECRET: SECRET,
          BETTER_AUTH_URL: STAGING_ORIGIN,
          D1_RUNTIME_ENV: 'staging',
          SITE_ENVIRONMENT: 'staging'
        })
      })
    ).toThrow(/only runs locally/u)
  })
})
