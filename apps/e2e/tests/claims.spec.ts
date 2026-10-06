import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test
} from '@playwright/test'
import {
  ADMIN_EMAIL_PREFIXES,
  type Client,
  client,
  q,
  removeLeftoverAdmins,
  signIn,
  signInAsNewAdmin,
  unique
} from './admin-fixture'
import { claimsD1, claimsOrigin, claimsServer, claimsSuiteEnabled } from './claims-fixture'
import { type FixtureSite, startFixtureSite } from './submit-fixture'

/**
 * Claims of existing listings (serpcompany/best.serp.co#67) end to end, through the claim API on
 * a local Worker with claims on (`LOCAL_CLAIMS=on`): the free claim (domain-email code, then the
 * badge on a fixture website), the refusals (webmail, another domain, a wrong, expired, or
 * over-attempt code, an existing owner, no session, a foreign origin), ownership in the account
 * dashboard and the admin panel, and the weekly badge program removing a badge claimer whose
 * badge is confirmed missing (#66). The claim dialog (#70 screen 8) is not built yet, so the
 * suite drives the API the dialog will call.
 */

test.skip(!claimsSuiteEnabled, 'needs the local claims Worker from playwright.config.ts')
test.describe.configure({ mode: 'serial' })
test.use({ baseURL: claimsOrigin() })

let fixture: FixtureSite
const baseURL = claimsOrigin()

interface Seeded {
  id: string
  label: string
  name: string
  slug: string
}

function seedListing(label: string, name: string): Seeded {
  fixture.set(label, { badge: 'missing', description: `${name}, a fixture.`, name })
  const slug = fixture.slug(label)
  const id = `e2e-claim-${label}`
  claimsD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum)
    VALUES (${q(id)}, ${q(slug)}, ${q(name)}, 'A listing for the claims suite.',
      ${q(fixture.website(label))}, 'Imported.', 'draft', '2026-05-16',
      'legacy-json-migration-v1', ${q(id)}, ${q(`e2e-${label}`)});
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(id)}, id, 0, 1 FROM categories WHERE slug = 'e2e-claim-tools';
    UPDATE listings SET status = 'approved' WHERE id = ${q(id)};
  `)
  return { id, label, name, slug }
}

async function account(email: string): Promise<{ client: Client; context: APIRequestContext }> {
  const context = await playwrightRequest.newContext({ baseURL })
  const user = client(context, baseURL)
  await signIn(user, email)
  return { client: user, context }
}

async function codeFor(request: APIRequestContext, to: string): Promise<string> {
  const response = await request.get(`/api/dev/email-outbox?to=${encodeURIComponent(to)}`)
  const { messages } = (await response.json()) as { messages: Array<{ subject: string }> }
  const subject = messages.map(message => message.subject).find(s => /code to claim/u.test(s))
  const code = /^(\d{6}) is your SERP code to claim /u.exec(subject ?? '')?.[1]
  if (!code) throw new Error(`no claim code for ${to}`)
  return code
}

async function claim(user: Client, body: Record<string, unknown>) {
  return user.request.post('/api/claims', { data: body, headers: user.headers })
}

async function step(user: Client, id: string, action: string, data: unknown = {}) {
  return user.request.post(`/api/claims/${id}/${action}`, { data, headers: user.headers })
}

test.beforeAll(async () => {
  fixture = await startFixtureSite()
  claimsD1(`
    INSERT OR IGNORE INTO publication_state (id, version, checksum) VALUES (1, 0, 'e2e-claims');
    INSERT OR IGNORE INTO categories (slug, name, description, sort_order)
      VALUES ('e2e-claim-tools', 'E2E Claim Tools', 'Tools for the claims suite.', 0);
  `)
  removeLeftoverAdmins([ADMIN_EMAIL_PREFIXES.claims], claimsServer)
})

test.afterAll(async () => {
  await fixture?.close()
})

test('claims a listing with the badge and a domain-email code; the badge program can take it back', async () => {
  const key = unique()
  const listing = seedListing(`claimed-${key}`, 'Claimed product')
  const owner = await account(`claimer-${key}@example.com`)
  const domainAddress = `jo@${listing.slug}`

  // Refused: webmail, another domain, an unknown listing, and the paid method while #68 is off.
  for (const [email, code] of [
    ['jo@gmail.com', 'webmail'],
    ['jo@example.org', 'domain_mismatch']
  ] as const) {
    const refused = await claim(owner.client, { email, listing: listing.slug, method: 'badge' })
    expect(refused.status()).toBe(422)
    expect(await refused.json()).toMatchObject({ code })
  }
  expect(
    (await claim(owner.client, { email: domainAddress, listing: 'nope', method: 'badge' })).status()
  ).toBe(404)
  expect(
    (
      await claim(owner.client, { email: domainAddress, listing: listing.slug, method: 'paid' })
    ).status()
  ).toBe(422)

  // The code goes to the domain address, in the subject.
  const started = await claim(owner.client, {
    email: domainAddress,
    listing: listing.slug,
    method: 'badge'
  })
  expect(started.status(), await started.text()).toBe(201)
  const { claim: opened } = (await started.json()) as { claim: { id: string; status: string } }
  expect(opened.status).toBe('code_sent')
  const code = await codeFor(owner.context, domainAddress)
  const wrong = code === '000000' ? '111111' : '000000'
  const miss = await step(owner.client, opened.id, 'confirm', { code: wrong })
  expect(miss.status()).toBe(422)
  expect(await miss.json()).toMatchObject({ attemptsLeft: 4, code: 'invalid_code' })
  const confirmed = await step(owner.client, opened.id, 'confirm', { code })
  expect(confirmed.status()).toBe(200)
  expect(await confirmed.json()).toMatchObject({ claim: { status: 'email_verified' } })

  // No badge yet: the claim stays open. With the badge published, it completes.
  const missing = await step(owner.client, opened.id, 'verify-badge')
  expect(await missing.json()).toMatchObject({
    claim: { status: 'email_verified' },
    result: { code: 'badge_missing' }
  })
  fixture.update(listing.label, { badge: 'valid' })
  // Skip the 30-second cooldown between checks.
  claimsD1(
    `UPDATE listing_claims SET badge_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = ${q(opened.id)}`
  )
  const passed = await step(owner.client, opened.id, 'verify-badge')
  expect(await passed.json()).toMatchObject({
    claim: { status: 'completed' },
    result: { ok: true }
  })
  expect(
    claimsD1(
      `SELECT verified_via FROM listing_owners WHERE listing_id = ${q(listing.id)} AND revoked_at IS NULL`
    )
  ).toEqual([{ verified_via: 'badge_claim' }])

  // The owner sees it in the account dashboard; an admin sees the owner and how they claimed it.
  const dashboard = await owner.context.get('/account/listings/')
  expect(dashboard.status()).toBe(200)
  expect(await dashboard.text()).toContain('Claimed product')
  const adminContext = await playwrightRequest.newContext({ baseURL })
  const admin = client(adminContext, baseURL)
  await signInAsNewAdmin(admin, ADMIN_EMAIL_PREFIXES.claims, claimsServer)
  const adminPage = await adminContext.get(`/admin/listings/${listing.slug}/`)
  expect(adminPage.status()).toBe(200)
  const adminHtml = await adminPage.text()
  expect(adminHtml).toContain(`claimer-${key}@example.com`)
  expect(adminHtml).toContain('Badge claim')

  // Someone else can't claim an owned listing; they get the contact path.
  const other = await account(`second-${key}@example.com`)
  const taken = await claim(other.client, {
    email: `pri@${listing.slug}`,
    listing: listing.slug,
    method: 'badge'
  })
  expect(taken.status()).toBe(409)
  expect(await taken.json()).toMatchObject({ code: 'already_owned', contactPath: '/contact/' })

  // The weekly badge program (#66): the badge goes missing, the recheck confirms it, and the
  // claimer loses ownership while the listing stays live.
  fixture.update(listing.label, { badge: 'missing' })
  expect(
    (await owner.context.get(`/__scheduled?cron=${encodeURIComponent('15 3 * * 1')}`)).status()
  ).toBe(200)
  claimsD1(
    `UPDATE badge_checks SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days') WHERE listing_id = ${q(listing.id)}`
  )
  expect(
    (await owner.context.get(`/__scheduled?cron=${encodeURIComponent('45 3 * * *')}`)).status()
  ).toBe(200)
  expect(
    claimsD1(`SELECT revoked_reason FROM listing_owners WHERE listing_id = ${q(listing.id)}`)
  ).toEqual([{ revoked_reason: 'badge_removed' }])
  expect((await owner.context.get(`/products/${listing.slug}/`)).status()).toBe(200)
  const outbox = await owner.context.get(
    `/api/dev/email-outbox?to=${encodeURIComponent(`claimer-${key}@example.com`)}`
  )
  const subjects = ((await outbox.json()) as { messages: Array<{ subject: string }> }).messages.map(
    m => m.subject
  )
  expect(subjects).toEqual(expect.arrayContaining([`You no longer manage Claimed product on SERP`]))

  await Promise.all([owner.context.dispose(), other.context.dispose(), adminContext.dispose()])
})

test('refuses expired and over-attempt codes, and requests without a session or from elsewhere', async () => {
  const key = unique()
  const listing = seedListing(`codes-${key}`, 'Code product')
  const user = await account(`codes-${key}@example.com`)
  const address = `team@${listing.slug}`
  const started = await claim(user.client, {
    email: address,
    listing: listing.slug,
    method: 'badge'
  })
  const { claim: opened } = (await started.json()) as { claim: { id: string } }
  const code = await codeFor(user.context, address)

  // Expired: the code's 10 minutes are over.
  claimsD1(
    `UPDATE listing_claims SET code_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ${q(opened.id)}`
  )
  const expired = await step(user.client, opened.id, 'confirm', { code })
  expect(expired.status()).toBe(410)
  expect(await expired.json()).toMatchObject({ code: 'code_expired' })

  // A new code after the resend cooldown, then five wrong codes lock the claim for 15 minutes.
  claimsD1(
    `UPDATE listing_claims SET code_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes') WHERE id = ${q(opened.id)}`
  )
  expect(
    (await claim(user.client, { email: address, listing: listing.slug, method: 'badge' })).status()
  ).toBe(201)
  const fresh = await codeFor(user.context, address)
  const wrong = fresh === '000000' ? '111111' : '000000'
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    expect((await step(user.client, opened.id, 'confirm', { code: wrong })).status()).toBe(422)
  }
  const locked = await step(user.client, opened.id, 'confirm', { code: wrong })
  expect(locked.status()).toBe(429)
  expect(await locked.json()).toMatchObject({ code: 'too_many_attempts', retryAfterSeconds: 900 })
  expect((await step(user.client, opened.id, 'confirm', { code: fresh })).status()).toBe(429)

  // An imported listing that links through serp.ly is claimed through its product's domain:
  // SERP's own mail never proves it (#108 review round 1).
  const imported = `e2e-claim-serply-${key}`
  claimsD1(`
    INSERT INTO listings (id, slug, name, description, website, content, status, published_at,
      source_kind, source_identity, checksum)
    VALUES (${q(imported)}, ${q(`${key}-tool.example`)}, 'Imported product', 'd',
      ${q(`https://serp.ly/${key}`)}, 'Imported.', 'draft', '2026-05-16',
      'legacy-json-migration-v1', ${q(imported)}, ${q(`e2e-${imported}`)});
    INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT ${q(imported)}, id, 0, 1 FROM categories WHERE slug = 'e2e-claim-tools';
    UPDATE listings SET status = 'approved' WHERE id = ${q(imported)};
  `)
  const serply = await claim(user.client, {
    email: 'team@serp.ly',
    listing: `${key}-tool.example`,
    method: 'badge'
  })
  expect(serply.status()).toBe(422)
  expect(await serply.json()).toMatchObject({ code: 'domain_mismatch' })

  // Someone else's claim reads as missing.
  const stranger = await account(`stranger-${key}@example.com`)
  expect((await step(stranger.client, opened.id, 'confirm', { code: fresh })).status()).toBe(404)

  // No session: 401. A foreign origin: 403 (CSRF).
  const anonymous = await playwrightRequest.newContext({ baseURL })
  const signedOut = await anonymous.post('/api/claims', {
    data: { email: address, listing: listing.slug, method: 'badge' },
    headers: { origin: baseURL }
  })
  expect(signedOut.status()).toBe(401)
  const foreign = await user.context.post('/api/claims', {
    data: { email: address, listing: listing.slug, method: 'badge' },
    headers: { ...user.client.headers, origin: 'https://evil.example' }
  })
  expect(foreign.status()).toBe(403)
  await Promise.all([user.context.dispose(), stranger.context.dispose(), anonymous.dispose()])
})
