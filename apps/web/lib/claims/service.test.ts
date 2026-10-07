import { createBadgeProgramOperations } from '@serpdirectory/data-ops/badge-program'
import { createClaimOperations } from '@serpdirectory/data-ops/claims'
import { createDatabase } from '@serpdirectory/data-ops/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteD1 } from '../../../../packages/data-ops/src/test-support'
import { features } from '../features'
import type { BadgeVerificationResult } from '../submissions/badge-verifier'
import { checkClaimAddress } from './address'
import { claimFlags } from './flags'
import {
  type ClaimDependencies,
  checkClaimBadge,
  claimTarget,
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
  const website = 'brieflow.ai'
  it('accepts an address on the product’s registrable domain, subdomains included', () => {
    expect(checkClaimAddress(' Jordan@Brieflow.AI ', website)).toEqual({
      address: 'jordan@brieflow.ai',
      domain: 'brieflow.ai',
      ok: true
    })
    expect(checkClaimAddress('jordan@mail.brieflow.ai', 'brieflow.ai')).toMatchObject({
      domain: 'brieflow.ai',
      ok: true
    })
    // The Public Suffix List's private section: each github.io site is its own domain.
    expect(checkClaimAddress('me@alice.github.io', 'alice.github.io')).toMatchObject({
      ok: true
    })
  })

  it('refuses webmail, other domains, shared hosts, and malformed addresses', () => {
    expect(checkClaimAddress('jordan@gmail.com', website)).toEqual({
      ok: false,
      problem: 'webmail'
    })
    // Webmail is refused even on the provider’s own listing.
    expect(checkClaimAddress('someone@gmail.com', 'gmail.com')).toEqual({
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
    expect(checkClaimAddress('me@bob.github.io', 'alice.github.io')).toMatchObject({
      problem: 'domain_mismatch'
    })
    expect(checkClaimAddress('me@github.io', 'github.io')).toMatchObject({
      problem: 'invalid_email'
    })
    // SERP's own domains never prove a product (#108 review round 1).
    for (const serp of ['serp.ly', 'serp.co']) {
      expect(checkClaimAddress(`team@${serp}`, serp)).toEqual({
        ok: false,
        problem: 'domain_mismatch'
      })
    }
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

  it('are on as the site ships (#130, #133): the badge or a payment, and the contact page', () => {
    for (const environment of ['staging', 'production']) {
      expect(
        claimFlags({ D1_RUNTIME_ENV: environment, SITE_ENVIRONMENT: environment }, features)
      ).toEqual({ contactPath: '/contact/', enabled: true, paid: true })
    }
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
  /** Where each listing link lands (`serp.ly` links), as the safe fetcher would find. */
  let landings: Record<string, string | null>
  let checkedPages: string[]
  /** Sends per address, for the recipient cap. */
  let sendsTo: Record<string, number>

  function deps(paidClaims = false): ClaimDependencies {
    return {
      codeKey: 'claim-test-key',
      contactPath: '/contact/',
      now: () => new Date(clock),
      operations: createClaimOperations({ client: createDatabase(sqlite.asD1Database()) }),
      paidClaims,
      resolveLanding: async url => landings[url] ?? null,
      async sendBudget({ address }) {
        sendsTo[address] = (sendsTo[address] ?? 0) + 1
        return sendsTo[address] > 3 ? { retryAfterSeconds: 3600 } : null
      },
      async sendCode(input) {
        sent.push(input)
      }
    }
  }

  function badgeDeps() {
    return {
      ...deps(),
      budget: async () => null,
      verifyBadge: async (claim: { productUrl: string }) => {
        checkedPages.push(claim.productUrl)
        return badge
      }
    }
  }

  const row = (sql: string, ...params: string[]) => sqlite.database.prepare(sql).get(...params)
  const lastCode = () => sent.at(-1)?.code ?? ''

  beforeEach(() => {
    clock = START
    sent = []
    landings = {}
    checkedPages = []
    sendsTo = {}
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
      ['lst_owned', 'owned-tool', 'https://owned.example/'],
      // Imported listings link through serp.ly: by a domain slug, or a name slug.
      ['lst_jasper', 'jasper.ai', 'https://serp.ly/jasper'],
      ['lst_named', 'notion', 'https://serp.ly/notion'],
      ['lst_lost', 'lost-tool', 'https://serp.ly/lost']
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

  it('expires codes, limits resends, and counts wrong codes across resends', async () => {
    const claim = await startBadge()
    const again = (email = 'jordan@brieflow.ai') =>
      startClaim(deps(), { email, listingSlug: 'brieflow', method: 'badge', userId: 'user_a' })
    // Resend: not within a minute.
    await expect(again()).resolves.toMatchObject({ code: 'cooldown', status: 429 })
    clock += 61 * SECOND
    await startBadge()
    expect(sent.map(item => item.codesSent)).toEqual([1, 2])

    // Expired after 10 minutes.
    clock += 10 * MINUTE + SECOND
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'code_expired', status: 410 })

    // Four wrong codes, then a new code to another address: the count carries over, so the
    // next wrong code locks the claim for 15 minutes (#108 review round 1, finding 2).
    await startBadge()
    const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000')
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        confirmClaimEmail(deps(), {
          claimId: claim.id,
          code: wrongFor(lastCode()),
          userId: 'user_a'
        })
      ).resolves.toMatchObject({ attemptsLeft: 5 - attempt, code: 'invalid_code' })
    }
    clock += 61 * SECOND
    await startBadge('ops@brieflow.ai')
    const right = lastCode()
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: wrongFor(right), userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'too_many_attempts', retryAfterSeconds: 900, status: 429 })
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: right, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'too_many_attempts' })
    await expect(again('ops@brieflow.ai')).resolves.toMatchObject({ code: 'too_many_attempts' })
    // After the lockout the burned code stays spent; a new one works.
    clock += 15 * MINUTE + SECOND
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: right, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'code_expired' })
    await startBadge('ops@brieflow.ai')
    await expect(
      confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    ).resolves.toMatchObject({ claim: { status: 'email_verified' }, ok: true })
    // Three codes an hour to one address: a fourth to jordan@ is refused.
    clock += 61 * SECOND
    await expect(again()).resolves.toMatchObject({ code: 'cooldown', retryAfterSeconds: 3600 })
  })

  it('claims a serp.ly-linked listing only through the product’s own domain', async () => {
    // A domain slug whose link lands on that domain: the badge is checked on the landing page.
    landings['https://serp.ly/jasper'] = 'https://www.jasper.ai/?fpr=devin'
    const start = (listingSlug: string, email: string) =>
      startClaim(deps(), { email, listingSlug, method: 'badge', userId: 'user_a' })
    await expect(start('jasper.ai', 'jo@serp.ly')).resolves.toMatchObject({
      code: 'domain_mismatch'
    })
    const jasper = await start('jasper.ai', 'jo@jasper.ai')
    if (!jasper.ok) throw new Error(jasper.code)
    await confirmClaimEmail(deps(), {
      claimId: jasper.claim.id,
      code: lastCode(),
      userId: 'user_a'
    })
    // Completion uses the stored domain: serp.ly being down now changes nothing.
    landings['https://serp.ly/jasper'] = null
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: jasper.claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ claim: { status: 'completed' }, ok: true })
    expect(checkedPages).toEqual(['https://www.jasper.ai/'])
    expect(row(`SELECT product_url FROM listing_claims WHERE listing_id='lst_jasper'`)).toEqual({
      product_url: 'https://www.jasper.ai/'
    })
    // The weekly program checks the claimer's product page, not the serp.ly link.
    const program = createBadgeProgramOperations({ client: createDatabase(sqlite.asD1Database()) })
    const due = await program.weeklyDue({
      cycleStart: '2026-10-05T03:15:00.000Z',
      limit: 10,
      now: new Date(clock).toISOString()
    })
    expect(due.map(item => [item.id, item.website])).toEqual([
      ['lst_jasper', 'https://www.jasper.ai/']
    ])

    // A name slug: the serp.ly link's landing page decides (the safe fetcher follows it).
    landings['https://serp.ly/notion'] = 'https://www.notion.com/?fpr=devin'
    await expect(start('notion', 'jo@serp.ly')).resolves.toMatchObject({ code: 'domain_mismatch' })
    const notion = await start('notion', 'jo@notion.com')
    if (!notion.ok) throw new Error(notion.code)
    expect(
      row(`SELECT email_domain, product_url FROM listing_claims WHERE listing_id='lst_named'`)
    ).toEqual({
      email_domain: 'notion.com',
      product_url: 'https://www.notion.com/'
    })
    // A link that lands on SERP's own page: no product domain. One that can't be followed: the
    // owner reviews it, and the claimer gets the contact path.
    landings['https://serp.ly/lost'] = 'https://serp.co/products/lost-tool/'
    await expect(start('lost-tool', 'jo@lost.example')).resolves.toMatchObject({
      code: 'no_product_domain',
      status: 409
    })
    landings['https://serp.ly/lost'] = null
    await expect(start('lost-tool', 'jo@lost.example')).resolves.toEqual({
      code: 'review_required',
      contactPath: '/contact/',
      ok: false,
      status: 409
    })
  })

  it('refuses a SERP, webmail, or malformed address before following the listing’s link', async () => {
    let followed = 0
    const counting = {
      ...deps(),
      resolveLanding: async () => {
        followed += 1
        return null
      }
    }
    for (const [email, code] of [
      ['team@serp.ly', 'domain_mismatch'],
      ['me@gmail.com', 'webmail'],
      ['nope', 'invalid_email']
    ] as const) {
      await expect(
        startClaim(counting, { email, listingSlug: 'notion', method: 'badge', userId: 'user_a' })
      ).resolves.toMatchObject({ code, status: 422 })
    }
    expect(followed).toBe(0)
  })

  it('sends #100’s owner-review listings and disagreeing links to the contact path', async () => {
    // codementorgpt.com is unregistered today (#108 review round 2): whoever registers it and
    // sets up mail would pass the email step, so an instant claim is refused.
    sqlite.database.exec(`
      INSERT INTO listings (id, slug, name, description, website, status, source_kind,
        source_identity, checksum)
      VALUES ('lst_lapsed', 'codementorgpt.com', 'CodeMentorGPT', 'd',
        'https://serp.ly/codementorgpt', 'draft', 'fixture', 'lst_lapsed', 'c');
      INSERT INTO listing_categories VALUES ('lst_lapsed', 1, 0, 1);
      UPDATE listings SET status = 'approved', published_at = '2026-05-16' WHERE id = 'lst_lapsed';
      INSERT INTO listing_claim_holds (listing_id, reason, source)
        VALUES ('lst_lapsed', 'unreachable', 'd1/hygiene/2026-10-06-listing-domains.yaml');
    `)
    // Even with a page that seems right (the new registrant's), the hold refuses it.
    landings['https://serp.ly/codementorgpt'] = 'https://codementorgpt.com/'
    const start = (listingSlug: string, email: string) =>
      startClaim(deps(), { email, listingSlug, method: 'badge', userId: 'user_a' })
    await expect(start('codementorgpt.com', 'me@codementorgpt.com')).resolves.toMatchObject({
      code: 'review_required',
      contactPath: '/contact/'
    })
    // Off-domain: the slug says jasper.ai, the link lands elsewhere.
    landings['https://serp.ly/jasper'] = 'https://evil.example/'
    await expect(start('jasper.ai', 'jo@jasper.ai')).resolves.toMatchObject({
      code: 'review_required'
    })
    await expect(start('jasper.ai', 'jo@evil.example')).resolves.toMatchObject({
      code: 'review_required'
    })
    // A cleared hold lets the claim through.
    sqlite.database.exec(`UPDATE listing_claim_holds SET cleared_at='2026-10-06T11:00:00.000Z',
      cleared_by='admin@example.com' WHERE listing_id='lst_lapsed'`)
    await expect(start('codementorgpt.com', 'me@codementorgpt.com')).resolves.toMatchObject({
      ok: true
    })
    expect(sent).toHaveLength(1)
  })

  it('re-checks the product domain at completion and reports a removed ownership', async () => {
    const claim = await startBadge()
    await confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    // An admin moved the website to another domain meanwhile: the claim can't complete.
    sqlite.database.exec(`UPDATE listings SET website='https://brieflow.com/' WHERE id='lst_brief'`)
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'changed', status: 409 })
    sqlite.database.exec(
      `UPDATE listings SET website='https://www.brieflow.ai/' WHERE id='lst_brief'`
    )
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ claim: { status: 'completed' }, ok: true })
    // The badge program removes the owner later: a replay no longer reports success.
    sqlite.database.exec(`UPDATE listing_owners SET revoked_at='2026-10-07T00:00:00.000Z',
      revoked_reason='badge_removed' WHERE listing_id='lst_brief'`)
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'not_owner', status: 409 })
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
    // A rival's confirmed paid claim, completed after this one, answers with the contact path.
    const rival = await startClaim(deps(true), {
      email: 'priya@brieflow.ai',
      listingSlug: 'brieflow',
      method: 'paid',
      userId: 'user_b'
    })
    if (!rival.ok) throw new Error(rival.code)
    await confirmClaimEmail(deps(true), {
      claimId: rival.claim.id,
      code: lastCode(),
      userId: 'user_b'
    })
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
    ).resolves.toEqual({ completed: true, completedNow: true, ok: true })
    expect(row(`SELECT verified_via FROM listing_owners WHERE listing_id='lst_brief'`)).toEqual({
      verified_via: 'paid_claim'
    })
    // A second payment for the same claim did not complete it (billing refunds that one).
    await expect(
      completePaidClaim(deps(true), {
        actor: 'stripe',
        claimId: started.claim.id,
        userId: 'user_a'
      })
    ).resolves.toEqual({ completed: true, completedNow: false, ok: true })
    await expect(
      completePaidClaim(deps(true), { actor: 'stripe', claimId: rival.claim.id, userId: 'user_b' })
    ).resolves.toMatchObject({ code: 'already_owned', contactPath: '/contact/' })
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

  it('gives the dialog its target, and resumes an open claim', async () => {
    await expect(
      claimTarget(deps(), { listingSlug: 'brieflow', userId: 'user_a' })
    ).resolves.toEqual({
      ok: true,
      target: {
        domain: 'brieflow.ai',
        listing: { name: 'Name brieflow', slug: 'brieflow' },
        openClaim: null,
        paid: false,
        productUrl: 'https://www.brieflow.ai/'
      }
    })
    const claim = await startBadge()
    await expect(
      claimTarget(deps(true), { listingSlug: 'brieflow', userId: 'user_a' })
    ).resolves.toMatchObject({
      target: { openClaim: { checksLeft: 10, id: claim.id, status: 'code_sent' }, paid: true }
    })
    const someoneElse = await claimTarget(deps(), { listingSlug: 'owned-tool', userId: 'user_a' })
    expect(someoneElse).toMatchObject({ code: 'already_owned', contactPath: '/contact/' })
    expect(someoneElse).not.toHaveProperty('self')
    // The owner asking hears that they manage it, never that someone else does.
    await expect(
      claimTarget(deps(), { listingSlug: 'owned-tool', userId: 'user_b' })
    ).resolves.toMatchObject({ code: 'already_owned', self: true })
  })

  it('allows ten badge checks that find a result, as at submit, and none after', async () => {
    const claim = await startBadge()
    await confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    badge = { code: 'badge_missing', ok: false }
    for (let check = 1; check <= 10; check += 1) {
      const result = await checkClaimBadge(badgeDeps(), {
        actor: 'a',
        claimId: claim.id,
        userId: 'user_a'
      })
      expect(result).toMatchObject({ claim: { checksLeft: 10 - check }, ok: true })
      clock += 31 * SECOND
    }
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'checks_used', status: 409 })
  })

  it('doesn’t count a check that couldn’t reach the site', async () => {
    const claim = await startBadge()
    await confirmClaimEmail(deps(), { claimId: claim.id, code: lastCode(), userId: 'user_a' })
    badge = { code: 'fetch_timeout', ok: false }
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ claim: { checksLeft: 10 }, result: { code: 'fetch_timeout' } })
  })

  it('needs a fresh confirmation to finish', async () => {
    const claim = await startBadge()
    const confirmed = await confirmClaimEmail(deps(), {
      claimId: claim.id,
      code: lastCode(),
      userId: 'user_a'
    })
    // The dialog reads when the confirmation runs out, to resume at the code step after it.
    expect(confirmed).toMatchObject({
      claim: { confirmedUntil: new Date(clock + 24 * 60 * MINUTE).toISOString() }
    })
    clock += 25 * 60 * MINUTE
    await expect(
      checkClaimBadge(badgeDeps(), { actor: 'a', claimId: claim.id, userId: 'user_a' })
    ).resolves.toMatchObject({ code: 'confirmation_expired', status: 410 })
  })
})
