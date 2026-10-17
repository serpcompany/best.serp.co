import { type APIRequestContext, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_EMAIL_PREFIXES, type Client, client, q, signIn, unique } from './admin-fixture'
import {
  claimCode,
  claimsD1,
  claimsOrigin,
  claimsSuiteEnabled,
  resetClaimDomainBudget,
  seedClaimsCatalog,
  seedClaimsListing
} from './claims-fixture'
import { type FixtureSite, startFixtureSite } from './submit-fixture'
import { test } from './test'

/**
 * Claims of existing listings (serpcompany/best.serp.co#67) end to end, through the claim API on
 * a local Worker with the site's flags (claims, the badge program, and orders on; #130, #133):
 * the free claim (domain-email code, then the badge on a fixture website), the refusals (webmail,
 * another domain, an unknown method, a wrong, expired, or over-attempt code,
 * an existing owner, a held listing, no session, a foreign origin), ownership in the account
 * dashboard and the admin panel, and the weekly badge program removing a badge claimer whose
 * badge is confirmed missing (#66). The dialog that calls this API is
 * `claims-dialog.spec.ts`'s.
 */

test.skip(!claimsSuiteEnabled, 'needs the local claims Worker from playwright.suites.config.ts')
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

async function seedListing(label: string, name: string): Promise<Seeded> {
  fixture.set(label, { badge: 'missing', description: `${name}, a fixture.`, name })
  const slug = fixture.slug(label)
  const id = `e2e-claim-${label}`
  await seedClaimsListing({
    content: 'Imported.',
    description: 'A listing for the claims suite.',
    id,
    name,
    slug,
    website: fixture.website(label)
  })
  return { id, label, name, slug }
}

async function account(email: string): Promise<{ client: Client; context: APIRequestContext }> {
  const context = await playwrightRequest.newContext({ baseURL })
  const user = client(context, baseURL)
  await signIn(user, email)
  return { client: user, context }
}

async function claim(user: Client, body: Record<string, unknown>) {
  return user.request.post('/api/claims', { data: body, headers: user.headers })
}

async function step(user: Client, id: string, action: string, data: unknown = {}) {
  return user.request.post(`/api/claims/${id}/${action}`, { data, headers: user.headers })
}

test.beforeAll(async () => {
  fixture = await startFixtureSite()
  await seedClaimsCatalog()
})

// Every attempt has its own listing, accounts, addresses, and client addresses; only the cap on
// the fixture domain is shared, so each starts with it empty (#200).
test.beforeEach(async () => {
  await resetClaimDomainBudget()
})

test.afterAll(async () => {
  await fixture?.close()
})

test('claims a listing with the badge and a domain-email code; the badge program can take it back', async () => {
  const key = unique()
  const listing = await seedListing(`claimed-${key}`, 'Claimed product')
  const owner = await account(`claimer-${key}@example.com`)
  const domainAddress = `jo@${listing.slug}`

  // Refused: webmail, another domain, an unknown listing, and an unknown method. (Orders are on,
  // #133, so the paid method starts a claim too; `billing.spec.ts` pays for one.)
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
  const unknown = await claim(owner.client, {
    email: domainAddress,
    listing: listing.slug,
    method: 'gift'
  })
  expect(unknown.status()).toBe(422)
  expect(await unknown.json()).toMatchObject({ code: 'invalid_method' })

  // The code goes to the domain address, in the subject.
  const started = await claim(owner.client, {
    email: domainAddress,
    listing: listing.slug,
    method: 'badge'
  })
  expect(started.status(), await started.text()).toBe(201)
  const { claim: opened } = (await started.json()) as { claim: { id: string; status: string } }
  expect(opened.status).toBe('code_sent')
  const code = await claimCode(owner.context, domainAddress)
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
  await claimsD1(
    `UPDATE listing_claims SET badge_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = ${q(opened.id)}`
  )
  const passed = await step(owner.client, opened.id, 'verify-badge')
  expect(await passed.json()).toMatchObject({
    claim: { status: 'completed' },
    result: { ok: true }
  })
  expect(
    await claimsD1(
      `SELECT verified_via FROM listing_owners WHERE listing_id = ${q(listing.id)} AND revoked_at IS NULL`
    )
  ).toEqual([{ verified_via: 'badge_claim' }])

  // The owner sees it in the account dashboard; an admin sees the owner and how they claimed it.
  const dashboard = await owner.context.get('/account/listings/')
  expect(dashboard.status()).toBe(200)
  expect(await dashboard.text()).toContain('Claimed product')
  // A fresh admin: on the allowlist before its first sign-in, off it once it has looked.
  const adminContext = await playwrightRequest.newContext({ baseURL })
  const adminEmail = `${ADMIN_EMAIL_PREFIXES.claims}-${key}@example.com`
  await claimsD1(`INSERT INTO admin_allowlist (email, added_by) VALUES (${q(adminEmail)}, 'e2e')`)
  await signIn(client(adminContext, baseURL), adminEmail)
  const adminPage = await adminContext.get(`/admin/listings/${listing.slug}/`)
  expect(adminPage.status()).toBe(200)
  const adminHtml = await adminPage.text()
  expect(adminHtml).toContain(`claimer-${key}@example.com`)
  expect(adminHtml).toContain('Badge claim')
  await claimsD1(`DELETE FROM admin_allowlist WHERE email = ${q(adminEmail)}`)

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
  // The passes check every listing on this Worker: another run's pass may have checked this one
  // while its badge was up, which would leave nothing due this week (#200).
  await claimsD1(`DELETE FROM badge_checks WHERE listing_id = ${q(listing.id)}`)
  expect(
    (await owner.context.get(`/__scheduled?cron=${encodeURIComponent('15 3 * * 1')}`)).status()
  ).toBe(200)
  await claimsD1(
    `UPDATE badge_checks SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days') WHERE listing_id = ${q(listing.id)}`
  )
  expect(
    (await owner.context.get(`/__scheduled?cron=${encodeURIComponent('45 3 * * *')}`)).status()
  ).toBe(200)
  expect(
    await claimsD1(`SELECT revoked_reason FROM listing_owners WHERE listing_id = ${q(listing.id)}`)
  ).toEqual([{ revoked_reason: 'badge_removed' }])
  expect((await owner.context.get(`/products/${listing.slug}/`)).status()).toBe(200)
  // The notice goes out after the scheduled run answers (`waitUntil`).
  await expect
    .poll(async () => {
      const outbox = await owner.context.get(
        `/api/dev/email-outbox?to=${encodeURIComponent(`claimer-${key}@example.com`)}`
      )
      return ((await outbox.json()) as { messages: Array<{ subject: string }> }).messages.map(
        m => m.subject
      )
    })
    .toEqual(expect.arrayContaining([`You no longer manage Claimed product on SERP Best`]))

  await Promise.all([owner.context.dispose(), other.context.dispose(), adminContext.dispose()])
})

test('refuses expired and over-attempt codes, and requests without a session or from elsewhere', async () => {
  const key = unique()
  const listing = await seedListing(`codes-${key}`, 'Code product')
  const user = await account(`codes-${key}@example.com`)
  const address = `team@${listing.slug}`
  const started = await claim(user.client, {
    email: address,
    listing: listing.slug,
    method: 'badge'
  })
  expect(started.status(), await started.text()).toBe(201)
  const { claim: opened } = (await started.json()) as { claim: { id: string } }
  const code = await claimCode(user.context, address)

  // Expired: the code's 10 minutes are over.
  await claimsD1(
    `UPDATE listing_claims SET code_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ${q(opened.id)}`
  )
  const expired = await step(user.client, opened.id, 'confirm', { code })
  expect(expired.status()).toBe(410)
  expect(await expired.json()).toMatchObject({ code: 'code_expired' })

  // A new code after the resend cooldown, then five wrong codes lock the claim for 15 minutes.
  await claimsD1(
    `UPDATE listing_claims SET code_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes') WHERE id = ${q(opened.id)}`
  )
  const resent = await claim(user.client, {
    email: address,
    listing: listing.slug,
    method: 'badge'
  })
  expect(resent.status(), await resent.text()).toBe(201)
  const fresh = await claimCode(user.context, address, 2)
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
  await seedClaimsListing({
    content: 'Imported.',
    description: 'd',
    id: imported,
    name: 'Imported product',
    slug: `${key}-tool.example`,
    website: `https://serp.ly/${key}`
  })
  const serply = await claim(user.client, {
    email: 'team@serp.ly',
    listing: `${key}-tool.example`,
    method: 'badge'
  })
  expect(serply.status()).toBe(422)
  expect(await serply.json()).toMatchObject({ code: 'domain_mismatch' })

  // A listing on #100's owner-review list is held: the claimer gets the contact path.
  const held = await seedListing(`held-${key}`, 'Held product')
  await claimsD1(`INSERT INTO listing_claim_holds (listing_id, reason, source)
    VALUES (${q(held.id)}, 'off_domain', 'd1/hygiene/2026-10-06-listing-domains.yaml')`)
  const heldClaim = await claim(user.client, {
    email: `team@${held.slug}`,
    listing: held.slug,
    method: 'badge'
  })
  expect(heldClaim.status()).toBe(409)
  expect(await heldClaim.json()).toMatchObject({
    code: 'review_required',
    contactPath: '/contact/'
  })

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
