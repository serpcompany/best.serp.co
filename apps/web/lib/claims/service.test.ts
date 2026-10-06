import { createBadgeProgramOperations } from '@serpdirectory/data-ops/badge-program'
import { createClaimOperations } from '@serpdirectory/data-ops/claims'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'
import type { BadgeVerificationResult } from '../submissions/badge-verifier'
import { checkClaimAddress } from './address'
import { claimFlags } from './flags'
import {
  type ClaimDependencies,
  checkClaimBadge,
  completePaidClaim,
  confirmClaimEmail,
  generateClaimCode,
  hashClaimCode,
  startClaim
} from './service'

const START = Date.parse('2026-10-06T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND

describe('claim addresses', () => {
  const website = 'https://www.brieflow.ai/'
  it('accepts an address on the website’s registrable domain, subdomains included', () => {
    expect(checkClaimAddress(' Jordan@Brieflow.AI ', website)).toEqual({
      address: 'jordan@brieflow.ai',
      domain: 'brieflow.ai',
      ok: true
    })
    expect(checkClaimAddress('jordan@mail.brieflow.ai', 'https://app.brieflow.ai/x')).toMatchObject(
      {
        domain: 'brieflow.ai',
        ok: true
      }
    )
    // The Public Suffix List's private section: each github.io site is its own domain.
    expect(checkClaimAddress('me@alice.github.io', 'https://alice.github.io/')).toMatchObject({
      ok: true
    })
  })

  it('refuses webmail, other domains, shared hosts, and malformed addresses', () => {
    expect(checkClaimAddress('jordan@gmail.com', website)).toEqual({
      ok: false,
      problem: 'webmail'
    })
    // Webmail is refused even on the provider’s own listing.
    expect(checkClaimAddress('someone@gmail.com', 'https://gmail.com/')).toEqual({
      ok: false,
      problem: 'webmail'
    })
    expect(checkClaimAddress('jordan@brieflow.com', website)).toEqual({
      ok: false,
      problem: 'domain_mismatch'
    })
    expect(checkClaimAddress('jordan@notbrieflow.ai', website)).toMatchObject({
      problem: 'domain_mismatch'
    })
    expect(checkClaimAddress('me@bob.github.io', 'https://alice.github.io/')).toMatchObject({
      problem: 'domain_mismatch'
    })
    expect(checkClaimAddress('me@github.io', 'https://github.io/')).toMatchObject({
      problem: 'invalid_email'
    })
    for (const bad of ['jordan', 'jordan@', '@brieflow.ai', 'a b@brieflow.ai', 'x@brieflow']) {
      expect(checkClaimAddress(bad, website), bad).toEqual({ ok: false, problem: 'invalid_email' })
    }
  })
})

describe('claim flags', () => {
  const off = {
    accountDashboard: true,
    badgeProgram: false,
    claims: false,
    listingFaqs: false,
    messages: false,
    orders: false
  }
  it('turns claims on only with the flag, or on a local Worker that asks', () => {
    const local = { D1_RUNTIME_ENV: 'local', LOCAL_CLAIMS: 'on', SITE_ENVIRONMENT: 'local' }
    expect(claimFlags({}, off)).toMatchObject({
      contactPath: '/contact/',
      enabled: false,
      paid: false
    })
    expect(claimFlags(local, off).enabled).toBe(true)
    expect(
      claimFlags({ ...local, D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' }, off)
        .enabled
    ).toBe(false)
    expect(claimFlags({}, { ...off, claims: true, messages: true, orders: true })).toEqual({
      contactPath: '/account/messages/new/?type=claim',
      enabled: true,
      paid: true
    })
  })
})

describe('claim codes', () => {
  it('are six digits and stored only as a hash bound to the claim', async () => {
    for (let i = 0; i < 50; i += 1) expect(generateClaimCode()).toMatch(/^\d{6}$/u)
    const a = await hashClaimCode('key', 'claim-a', '123456')
    expect(a).toMatch(/^[0-9a-f]{64}$/u)
    expect(await hashClaimCode('key', 'claim-b', '123456')).not.toBe(a)
    expect(await hashClaimCode('other', 'claim-a', '123456')).not.toBe(a)
  })
})

describe('claim flow', () => {
  let sqlite: SqliteD1
  let clock: number
  let sent: Array<{
    claimId: string
    code: string
    codesSent: number
    listingName: string
    to: string
  }>
  let badge: BadgeVerificationResult

  function deps(paidClaims = false): ClaimDependencies {
    return {
      codeKey: 'claim-test-key',
      contactPath: '/contact/',
      now: () => new Date(clock),
      operations: createClaimOperations({ client: createDatabase(sqlite.asD1Database()) }),
      paidClaims,
      async sendCode(input) {
        sent.push(input)
      }
    }
  }

  function badgeDeps() {
    return {
      ...deps(),
      budget: async () => null,
      verifyBadge: async () => badge
    }
  }

  const row = (sql: string, ...params: string[]) => sqlite.database.prepare(sql).get(...params)
  const lastCode = () => sent.at(-1)?.code ?? ''

  beforeEach(() => {
    clock = START
    sent = []
    badge = { ok: true }
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO categories (slug, name, description, sort_order, is_active)
        VALUES ('tools', 'Tools', 'Tools', 0, 1);
      INSERT INTO publication_state (id, version, checksum, published_at)
        VALUES (1, 1, 'before', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, name, email, email_verified) VALUES
        ('user_a', 'A', 'a@example.com', 1), ('user_b', 'B', 'b@example.com', 1);
    `)
    for (const [id, slug, website] of [
      ['lst_brief', 'brieflow', 'https://www.brieflow.ai/'],
      ['lst_owned', 'owned-tool', 'https://owned.example/']
    ] as const) {
      sqlite.database.exec(`
        INSERT INTO listings (id, slug, name, description, website, status, source_kind,
          source_identity, checksum)
        VALUES ('${id}', '${slug}', 'Name ${slug}', 'd', '${website}', 'draft', 'fixture', '${id}', 'c');
        INSERT INTO listing_categories VALUES ('${id}', 1, 0, 1);
        UPDATE listings SET status = 'approved', published_at = '2026-05-16' WHERE id = '${id}';
      `)
    }
    sqlite.database.exec(`INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES ('lst_owned', 'user_b', 'admin', '2026-09-01T00:00:00.000Z')`)
  })

  async function startBadge(email = 'jordan@brieflow.ai', userId = 'user_a') {
    const started = await startClaim(deps(), {
      email,
      listingSlug: 'brieflow',
      method: 'badge',
      userId
    })
    if (!started.ok) throw new Error(started.code)
    return started.claim
  }

  it('claims a listing with the badge: code by email, then the badge, then ownership', async () => {
    const claim = await startBadge()
    expect(claim).toMatchObject({
      attemptsLeft: 5,
      email: 'jordan@brieflow.ai',
      listing: { name: 'Name brieflow', slug: 'brieflow' },
      method: 'badge',
      status: 'code_sent'
    })
    expect(sent).toEqual([
      expect.objectContaining({
        claimId: claim.id,
        codesSent: 1,
        listingName: 'Name brieflow',
        to: 'jordan@brieflow.ai'
      })
    ])
    // The code is never stored in plain text.
    const stored = row('SELECT code_hash FROM listing_claims WHERE id=?', claim.id) as {
      code_hash: string
    }
    expect(stored.code_hash).not.toContain(lastCode())

    // The badge can't be checked before the address is confirmed.
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a@example.com', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'not_confirmed' })

    const confirmed = await confirmClaimEmail(deps(), {
      claimId: claim.id,
      code: lastCode(),
      userId: 'user_a'
    })
    expect(confirmed).toMatchObject({ claim: { status: 'email_verified' }, ok: true })
    // Single use: the code is gone.
    expect(row('SELECT code_hash FROM listing_claims WHERE id=?', claim.id)).toEqual({
      code_hash: null
    })

    // A missing badge leaves the claim open; a pass makes the claimer the owner.
    badge = { code: 'badge_missing', ok: false }
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a@example.com', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({
      claim: { status: 'email_verified' },
      ok: true,
      result: { code: 'badge_missing' }
    })
    // One check per 30 seconds.
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a@example.com', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'cooldown', status: 429 })
    clock += 31 * SECOND
    badge = { ok: true }
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a@example.com', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ claim: { status: 'completed' }, ok: true })
    expect(
      row(`SELECT user_id, verified_via FROM listing_owners WHERE listing_id='lst_brief'`)
    ).toEqual({ user_id: 'user_a', verified_via: 'badge_claim' })
    expect(
      row(`SELECT event_type, actor FROM listing_events WHERE listing_id='lst_brief'`)
    ).toEqual({ actor: 'a@example.com', event_type: 'owner_granted' })
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 2 })

    // The weekly badge program (#66) now checks it, on the branch that removes the owner.
    const program = createBadgeProgramOperations({ client: createDatabase(sqlite.asD1Database()) })
    const due = await program.weeklyDue({
      cycleStart: '2026-10-05T03:15:00.000Z',
      limit: 10,
      now: new Date(clock).toISOString()
    })
    expect(due.map(item => [item.id, item.branch, item.ownerEmail])).toEqual([
      ['lst_brief', 'revoke', 'a@example.com']
    ])
  })

  it('refuses webmail, another domain, an unknown or owned listing, and the paid method while #68 is off', async () => {
    const start = (input: Partial<{ email: string; listingSlug: string; method: string }>) =>
      startClaim(deps(), {
        email: 'jordan@brieflow.ai',
        listingSlug: 'brieflow',
        method: 'badge',
        userId: 'user_a',
        ...input
      })
    await expect(start({ email: 'jordan@gmail.com' })).resolves.toMatchObject({
      code: 'webmail',
      status: 422
    })
    await expect(start({ email: 'jordan@brieflow.com' })).resolves.toMatchObject({
      code: 'domain_mismatch',
      status: 422
    })
    await expect(start({ listingSlug: 'nope' })).resolves.toMatchObject({
      code: 'not_found',
      status: 404
    })
    await expect(start({ email: 'x@owned.example', listingSlug: 'owned-tool' })).resolves.toEqual({
      code: 'already_owned',
      contactPath: '/contact/',
      ok: false,
      status: 409
    })
    await expect(start({ method: 'paid' })).resolves.toMatchObject({ code: 'invalid_method' })
    // A prohibited block on the domain refuses it too.
    sqlite.database.exec(`INSERT INTO listing_submissions (id,slug,name,description,website,content,category_slug,logo_url,status,rejection_reason,rejection_category)
      VALUES ('sub_x','brieflow.ai','x','d','https://brieflow.ai/','c','tools','l','rejected','No','prohibited');
      INSERT INTO listing_submission_url_blocks (url_key,covers_subdomains,submission_id,reason,blocked_by,blocked_at)
      VALUES ('brieflow.ai',1,'sub_x','No','admin','2026-10-01T00:00:00.000Z')`)
    await expect(start({})).resolves.toMatchObject({ code: 'blocked', status: 409 })
    expect(sent).toEqual([])
  })

  it('expires codes, limits resends, and locks after five wrong codes', async () => {
    const claim = await startBadge()
    // Resend: not within a minute, then a new code that replaces the old one.
    await expect(
      startClaim(deps(), {
        email: 'jordan@brieflow.ai',
        listingSlug: 'brieflow',
        method: 'badge',
        userId: 'user_a'
      })
    ).resolves.toMatchObject({ code: 'cooldown', status: 429 })
    const first = lastCode()
    clock += 61 * SECOND
    await startBadge()
    expect(sent.map(item => item.codesSent)).toEqual([1, 2])
    if (first !== lastCode()) {
      await expect(
        confirmClaimEmail(deps(), { claimId: claim.id, code: first, userId: 'user_a' })
      ).resolves.toMatchObject({ code: 'invalid_code', attemptsLeft: 4 })
    }

    // Expired after 10 minutes.
    clock += 10 * MINUTE + SECOND
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'code_expired', status: 410 })

    // A fresh code, then five wrong ones: locked for 15 minutes, and the code is burned.
    await startBadge()
    const right = lastCode()
    const wrong = right === '000000' ? '111111' : '000000'
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        confirmClaimEmail(deps(), { claimId: claim.id, code: wrong, userId: 'user_a' })
      ).resolves.toMatchObject({ attemptsLeft: 5 - attempt, code: 'invalid_code' })
    }
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: wrong, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'too_many_attempts', retryAfterSeconds: 900, status: 429 })
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: right, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'too_many_attempts' })
    await expect(
      startClaim(deps(), {
        email: 'jordan@brieflow.ai',
        listingSlug: 'brieflow',
        method: 'badge',
        userId: 'user_a'
      })
    ).resolves.toMatchObject({ code: 'too_many_attempts' })
    // After the lockout the right code is still spent; a new one works.
    clock += 15 * MINUTE + SECOND
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: right, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'code_expired' })
    await startBadge()
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    ).resolves.toMatchObject({ claim: { status: 'email_verified' }, ok: true })
  })

  it('keeps each claim to its claimer and lets only the first completion win', async () => {
    const mine = await startBadge('jordan@brieflow.ai', 'user_a')
    const theirs = await startBadge('priya@brieflow.ai', 'user_b')
    await expect(
      confirmClaimEmail(deps(), { claimId: mine.id, code: '123456', userId: 'user_b' })
    ).resolves.toMatchObject({ code: 'not_found', status: 404 })
    const codes = Object.fromEntries(sent.map(item => [item.claimId, item.code]))
    await confirmClaimEmail(deps(), {
      claimId: mine.id,
      code: codes[mine.id] ?? '',
      userId: 'user_a'
    })
    await confirmClaimEmail(deps(), {
      claimId: theirs.id,
      code: codes[theirs.id] ?? '',
      userId: 'user_b'
    })
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'b@example.com', claimId: theirs.id, userId: 'user_b' })
    ).resolves.toMatchObject({ ok: true, claim: { status: 'completed' } })
    // The other claim is cancelled, and the listing now refuses claims with a contact path.
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a@example.com', claimId: mine.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'already_owned', contactPath: '/contact/' })
    expect(row('SELECT status FROM listing_claims WHERE id=?', mine.id)).toEqual({
      status: 'cancelled'
    })
    await expect(
      startClaim(deps(), {
        email: 'jordan@brieflow.ai',
        listingSlug: 'brieflow',
        method: 'badge',
        userId: 'user_a'
      })
    ).resolves.toMatchObject({ code: 'already_owned' })
  })

  it('completes a paid claim only behind the orders flag, after the address and a payment (#68)', async () => {
    const started = await startClaim(deps(true), {
      email: 'jordan@brieflow.ai',
      listingSlug: 'brieflow',
      method: 'paid',
      userId: 'user_a'
    })
    if (!started.ok) throw new Error(started.code)
    await expect(
      completePaidClaim(deps(true), {
        actor: 'stripe',
        claimId: started.claim.id,
        userId: 'user_a'
      })
    ).resolves.toMatchObject({ code: 'not_confirmed' })
    await confirmClaimEmail(deps(true), {
      claimId: started.claim.id,
      code: lastCode(),
      userId: 'user_a'
    })
    // The paid method never checks a badge.
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: started.claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'invalid_method' })
    await expect(
      completePaidClaim(deps(false), {
        actor: 'stripe',
        claimId: started.claim.id,
        userId: 'user_a'
      })
    ).resolves.toMatchObject({ code: 'not_found' })
    await expect(
      completePaidClaim(deps(true), {
        actor: 'stripe',
        claimId: started.claim.id,
        userId: 'user_a'
      })
    ).resolves.toEqual({ completed: true, ok: true })
    expect(row(`SELECT verified_via FROM listing_owners WHERE listing_id='lst_brief'`)).toEqual({
      verified_via: 'paid_claim'
    })
    // Never badge-checked by the weekly program.
    const program = createBadgeProgramOperations({ client: createDatabase(sqlite.asD1Database()) })
    await expect(
      program.weeklyDue({
        cycleStart: '2026-10-05T03:15:00.000Z',
        limit: 10,
        now: new Date(clock).toISOString()
      })
    ).resolves.toEqual([])
  })

  it('needs a fresh confirmation to finish', async () => {
    const claim = await startBadge()
    await confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    clock += 25 * 60 * MINUTE
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'confirmation_expired', status: 410 })
  })
})
