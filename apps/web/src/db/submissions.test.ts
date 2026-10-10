import { beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from './client'
import {
  buildSubmissionReviewPreview,
  createSubmissionOperations,
  type NewDraftInput
} from './submissions'
import { insertPublishedListing, SqliteD1 } from './test-support'

const OWNER = 'user_owner'
const OTHER = 'user_other'
const SAVED_AT = '2026-08-01T00:00:00.000Z'

const input: NewDraftInput = {
  categorySlug: 'tools',
  content: 'Long form submitted content.',
  description: 'A sufficiently descriptive submission.',
  logoUrl: 'https://assets.example.com/logo.png',
  name: 'Example',
  website: 'https://example.com/'
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

describe('native submission intake', () => {
  let sqlite: SqliteD1
  let now: Date

  beforeEach(() => {
    now = new Date(SAVED_AT)
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO categories(id,slug,name,description,sort_order,is_active) VALUES
        (1,'tools','Tools','Tools',0,1),
        (2,'retired','Retired','Retired',1,0);
      INSERT INTO publication_state(id,version,checksum,published_at)
        VALUES (1,1,'before','2026-01-01T00:00:00.000Z');
      INSERT INTO users(id,name,email,email_verified) VALUES
        ('${OWNER}','','owner@example.com',1),
        ('${OTHER}','','other@example.com',1);
    `)
  })

  function operations() {
    return createSubmissionOperations({
      client: createDatabase(sqlite.asD1Database()),
      clock: () => now,
      mediaBaseUrl: 'https://cdn.serp.co'
    })
  }

  function draft(overrides: Partial<NewDraftInput> = {}, ownerUserId = OWNER) {
    return operations().createDraft({ ownerUserId, submission: { ...input, ...overrides } })
  }

  function count(table: string): number {
    return Number(
      (sqlite.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
        .count
    )
  }

  it('saves a native draft: owner, no plan, draft clock, and block key from urlKey()', async () => {
    const saved = await draft({ website: 'https://www.Example.COM./pricing' })
    expect(saved).toMatchObject({
      categoryName: 'Tools',
      contentVersion: 1,
      draftSavedAt: SAVED_AT,
      plan: null,
      slug: 'example.com',
      status: 'draft'
    })
    expect(
      sqlite.database
        .prepare(
          `SELECT status,plan,owner_user_id,draft_saved_at,block_key,block_covers_subdomains
            FROM listing_submissions`
        )
        .get()
    ).toEqual({
      block_covers_subdomains: 1,
      block_key: 'example.com',
      draft_saved_at: SAVED_AT,
      owner_user_id: OWNER,
      plan: null,
      status: 'draft'
    })
    expect(
      sqlite.database
        .prepare('SELECT event_type,actor FROM listing_submission_events WHERE submission_id=?')
        .all(saved.id)
    ).toEqual([{ actor: OWNER, event_type: 'created' }])
  })

  it('keeps the long description optional and trims every field', async () => {
    const saved = await draft({ content: '   ', description: '  Short.  ', name: ' Example ' })
    expect(saved).toMatchObject({ content: '', description: 'Short.', name: 'Example' })
  })

  it('validates fields before writing anything', async () => {
    const cases: Array<[Partial<NewDraftInput>, string]> = [
      [{ website: 'http://127.0.0.1/private' }, 'invalid_url'],
      [{ website: 'not a url' }, 'invalid_url'],
      [{ name: ' ' }, 'invalid_name'],
      [{ description: '' }, 'invalid_description'],
      [{ description: 'x'.repeat(161) }, 'invalid_description'],
      [{ content: 'x'.repeat(5001) }, 'invalid_content'],
      [{ categorySlug: 'missing' }, 'invalid_category'],
      [{ categorySlug: 'retired' }, 'invalid_category'],
      [{ logoUrl: 'http://10.0.0.1/logo.png' }, 'invalid_logo'],
      [{ logoUrl: 'http://assets.example.com/logo.png' }, 'invalid_logo'],
      [{ logoUrl: 'https://user:pass@assets.example.com/logo.png' }, 'invalid_logo'],
      [{ logoUrl: '' }, 'invalid_logo']
    ]
    for (const [overrides, code] of cases) {
      await expect(draft(overrides), JSON.stringify(overrides)).rejects.toMatchObject({ code })
    }
    expect(count('listing_submissions')).toBe(0)
    await expect(draft({ description: 'x'.repeat(160) })).resolves.toMatchObject({
      status: 'draft'
    })
    // A local Worker accepts http logos, for its http fixture sites.
    const local = createSubmissionOperations({
      allowInsecureLogos: true,
      client: createDatabase(sqlite.asD1Database()),
      clock: () => now
    })
    await expect(
      local.createDraft({
        ownerUserId: OWNER,
        submission: {
          ...input,
          logoUrl: 'http://assets.example.com/logo.png',
          website: 'https://local.example.org/'
        }
      })
    ).resolves.toMatchObject({ logoUrl: 'http://assets.example.com/logo.png' })
  })

  it('refuses a website whose slug would end in a file extension', async () => {
    for (const website of [
      'https://chart.js/',
      'https://www.p5.JS/',
      'https://feed.example.xml/'
    ]) {
      await expect(draft({ website }), website).rejects.toMatchObject({
        code: 'invalid_url',
        status: 400
      })
    }
    expect(count('listing_submissions')).toBe(0)
    await expect(draft({ website: 'https://autoenhance.ai/' })).resolves.toMatchObject({
      slug: 'autoenhance.ai'
    })
  })

  it('blocks every variant and subdomain of a prohibited registrable domain', async () => {
    sqlite.database.exec(`INSERT INTO listing_submission_url_blocks
      (url_key,covers_subdomains,reason,blocked_by,blocked_at) VALUES
      ('casino.com',1,'Prohibited','admin','2026-08-01T00:00:00.000Z'),
      ('xn--bcher-kva.de',1,'Prohibited','admin','2026-08-01T00:00:00.000Z'),
      ('github.io',0,'Prohibited','admin','2026-08-01T00:00:00.000Z')`)
    for (const website of [
      'https://casino.com/',
      'https://casino.com./',
      'https://casino.com%2E/',
      'https://CASINO.com/',
      'https://www.Casino.com./',
      'https://ｃａｓｉｎｏ.com/',
      'https://go.casino.com/',
      'https://www2.casino.com/',
      'https://bücher.de/',
      'https://github.io/'
    ]) {
      await expect(operations().checkUrl(website, OWNER), website).resolves.toMatchObject({
        kind: 'blocked'
      })
      await expect(draft({ website }), website).rejects.toMatchObject({
        availability: { kind: 'blocked' },
        code: 'url_blocked',
        status: 403
      })
    }
    expect(count('listing_submissions')).toBe(0)
    // An exact-host block on a public suffix never covers the separate sites under it.
    for (const website of ['https://notcasino.com/', 'https://unrelated-user.github.io/']) {
      await expect(draft({ website }), website).resolves.toMatchObject({
        slug: new URL(website).hostname
      })
    }
  })

  it('answers duplicates by URL key: listed, pending mine, and pending someone else’s', async () => {
    insertPublishedListing(sqlite.database, {
      categoryIds: [1],
      content: null,
      description: 'Listed.',
      displayOrder: 0,
      id: 'lst_brieflow',
      isFeatured: false,
      name: 'Brieflow',
      publishedAt: '2026-07-01',
      slug: 'brieflow.ai',
      website: 'https://serp.ly/brieflow'
    })
    // Only the hosted copy is ever shown, on the environment's media host (#95).
    const logoKey = `best.serp.co/listings/brieflow.ai/logo/${'a'.repeat(16)}.png`
    sqlite.database
      .prepare(
        "INSERT INTO listing_media(listing_id,kind,url,sort_order) VALUES ('lst_brieflow','logo','https://assets.example.com/brieflow.png',0)"
      )
      .run()
    await expect(operations().checkUrl('https://brieflow.ai/')).resolves.toMatchObject({
      listing: { logoUrl: null }
    })
    sqlite.database
      .prepare(
        `UPDATE listing_media SET media_key=?,sha256=?,content_type='image/png',bytes=10,width=1,
          height=1 WHERE listing_id='lst_brieflow'`
      )
      .run(logoKey, 'a'.repeat(64))
    const listed = {
      kind: 'listed',
      listing: {
        categoryName: 'Tools',
        logoUrl: `https://cdn.serp.co/${logoKey}`,
        name: 'Brieflow',
        public: true,
        slug: 'brieflow.ai'
      }
    }
    await expect(operations().checkUrl('https://brieflow.ai/pricing')).resolves.toEqual(listed)
    await expect(operations().checkUrl('https://serp.ly/brieflow')).resolves.toEqual(listed)
    await expect(draft({ website: 'https://www.brieflow.ai/' })).rejects.toMatchObject({
      availability: listed,
      code: 'listing_exists',
      status: 409
    })

    const mine = await draft()
    await expect(operations().checkUrl('https://example.com%2E/', OWNER)).resolves.toEqual({
      kind: 'pending',
      mine: { id: mine.id, status: 'draft' },
      slug: 'example.com'
    })
    await expect(draft({ website: 'https://EXAMPLE.com/about' })).rejects.toMatchObject({
      availability: { kind: 'pending', mine: { id: mine.id } },
      code: 'duplicate_submission'
    })
    await expect(draft({}, OTHER)).rejects.toMatchObject({
      availability: { kind: 'pending', mine: null, slug: 'example.com' },
      code: 'duplicate_submission'
    })
    await expect(operations().checkUrl('https://example.com/')).resolves.toMatchObject({
      mine: null
    })
    // A subdomain is a separate site with the same block key.
    await expect(draft({ website: 'https://go.example.com/' })).resolves.toMatchObject({
      slug: 'go.example.com'
    })
    await expect(operations().checkUrl('https://new.example.org/')).resolves.toEqual({
      kind: 'available',
      slug: 'new.example.org'
    })
  })

  it('refuses a website another listing stores in another spelling (#64 review)', async () => {
    // Imported listings mostly have a slug that isn't their host.
    insertPublishedListing(sqlite.database, {
      categoryIds: [1],
      content: 'Content',
      description: 'Description',
      displayOrder: 0,
      id: 'lst_beta',
      isFeatured: false,
      name: 'Beta Tool',
      publishedAt: '2026-05-16',
      slug: 'beta-tool',
      website: 'https://www.new.example'
    })
    const listed = (website: string) =>
      Promise.all([
        expect(draft({ website }), website).rejects.toMatchObject({
          code: 'listing_exists',
          status: 409
        }),
        expect(operations().checkUrl(website), website).resolves.toMatchObject({
          kind: 'listed',
          listing: { name: 'Beta Tool', slug: 'beta-tool' }
        })
      ])
    for (const website of [
      'https://new.example/',
      'http://new.example',
      'https://www.new.example/',
      'https://new.example/?ref=producthunt',
      'https://new.example/#top'
    ]) {
      await listed(website)
    }
    // The other direction: a stored website with a query or fragment.
    sqlite.database
      .prepare("UPDATE listings SET website='https://new.example/?ref=abc#top' WHERE id='lst_beta'")
      .run()
    for (const website of ['https://new.example/', 'https://www.new.example#pricing']) {
      await listed(website)
    }
    // Another page on that host isn't matched: comparing stored websites by host is #94.
    await expect(draft({ website: 'https://new.example/other' })).resolves.toMatchObject({
      slug: 'new.example'
    })
  })

  it('frees the URL key once a draft is withdrawn', async () => {
    const first = await draft()
    sqlite.database
      .prepare(
        "UPDATE listing_submissions SET status='withdrawn',withdrawal_reason='expired' WHERE id=?"
      )
      .run(first.id)
    await expect(draft()).resolves.toMatchObject({ status: 'draft' })
  })

  it('scopes every read and write to the owner', async () => {
    const saved = await draft()
    await expect(operations().getOwnSubmission(saved.id, OTHER)).resolves.toBeNull()
    await expect(operations().listOwnSubmissions(OTHER)).resolves.toEqual([])
    await expect(operations().listOwnSubmissions(OWNER)).resolves.toMatchObject([{ id: saved.id }])
    await expect(
      operations().updateDraft({
        content: { ...input, name: 'Hijacked' },
        expectedContentVersion: 1,
        ownerUserId: OTHER,
        submissionId: saved.id
      })
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await expect(operations().chooseFreePlan(saved.id, OTHER)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(operations().claimVerification(saved.id, OTHER)).rejects.toMatchObject({
      code: 'not_found'
    })
    expect(sqlite.database.prepare('SELECT name,status FROM listing_submissions').get()).toEqual({
      name: 'Example',
      status: 'draft'
    })
  })

  it('edits a draft without resetting its draft clock and refuses a stale edit', async () => {
    const saved = await draft()
    now = new Date('2026-08-05T00:00:00.000Z')
    const edited = await operations().updateDraft({
      content: { ...input, description: 'Edited.', name: 'Example 2' },
      expectedContentVersion: saved.contentVersion,
      ownerUserId: OWNER,
      submissionId: saved.id
    })
    expect(edited).toMatchObject({
      contentVersion: 2,
      description: 'Edited.',
      draftSavedAt: SAVED_AT,
      name: 'Example 2',
      status: 'draft',
      website: input.website
    })
    await expect(
      operations().updateDraft({
        content: input,
        expectedContentVersion: 1,
        ownerUserId: OWNER,
        submissionId: saved.id
      })
    ).rejects.toMatchObject({ code: 'stale_submission', status: 409 })
  })

  it('stores up to three active suggested tags, in order, and keeps them through an edit (#341)', async () => {
    sqlite.database.exec(`
      INSERT INTO tags (slug,name,category_id,sort_order,is_active) VALUES
        ('note-taking','Note Taking',1,0,1),('whiteboards','Whiteboards',1,1,1),
        ('mockups','Mockups',1,2,1),('apis','APIs',1,3,1),('gone','Gone',1,4,0);
    `)
    const stored = () =>
      (
        sqlite.database.prepare('SELECT tag_slugs FROM listing_submissions').get() as {
          tag_slugs: string | null
        }
      ).tag_slugs
    const saved = await draft({ tagSlugs: ['whiteboards', 'note-taking'] })
    expect(saved.tagSlugs).toEqual(['whiteboards', 'note-taking'])
    expect(stored()).toBe('["whiteboards","note-taking"]')
    const edit = (tagSlugs: string[] | undefined, version: number) =>
      operations().updateDraft({
        content: { ...input, tagSlugs },
        expectedContentVersion: version,
        ownerUserId: OWNER,
        submissionId: saved.id
      })
    // Left out, the tags stay; an empty list is "not given".
    expect((await edit(undefined, 1)).tagSlugs).toEqual(['whiteboards', 'note-taking'])
    expect((await edit([], 2)).tagSlugs).toEqual([])
    expect(stored()).toBeNull()
    for (const tagSlugs of [['gone'], ['nope'], ['apis', 'apis']]) {
      await expect(edit(tagSlugs, 3)).rejects.toMatchObject({ code: 'invalid_tags' })
    }
    await expect(edit(['note-taking', 'whiteboards', 'mockups', 'apis'], 3)).rejects.toMatchObject({
      code: 'invalid_tags'
    })
    await expect(
      draft({ tagSlugs: ['gone'], website: 'https://other.example/' })
    ).rejects.toMatchObject({ code: 'invalid_tags' })
    expect(count('listing_submissions')).toBe(1)
  })

  it('chooses the free plan once and refuses an expired draft', async () => {
    const saved = await draft()
    const chosen = await operations().chooseFreePlan(saved.id, OWNER)
    expect(chosen).toMatchObject({ plan: 'free', status: 'pending_badge' })
    await expect(operations().chooseFreePlan(saved.id, OWNER)).rejects.toMatchObject({
      code: 'plan_not_available',
      status: 409
    })
    // A pending-badge submission can still be edited by its owner.
    await expect(
      operations().updateDraft({
        content: { ...input, name: 'Renamed' },
        expectedContentVersion: chosen.contentVersion,
        ownerUserId: OWNER,
        submissionId: saved.id
      })
    ).resolves.toMatchObject({ name: 'Renamed', status: 'pending_badge' })

    const old = await draft({ website: 'https://old.example.org/' })
    now = new Date('2026-09-01T00:00:00.000Z')
    await expect(operations().chooseFreePlan(old.id, OWNER)).rejects.toMatchObject({
      code: 'plan_not_available'
    })
    expect(
      sqlite.database.prepare('SELECT status,plan FROM listing_submissions WHERE id=?').get(old.id)
    ).toEqual({ plan: null, status: 'draft' })
  })

  async function pendingBadge() {
    const saved = await draft()
    return operations().chooseFreePlan(saved.id, OWNER)
  }

  /** Claims a check and records `result` for it. */
  async function check(id: string, result: { ok: true } | { code: string; ok: false }) {
    const { claimedAt } = await operations().claimVerification(id, OWNER)
    return operations().finishVerification(id, OWNER, claimedAt, result)
  }

  // PR #84 review round 1, finding 2: the cooldown and the cap are claimed before any fetch.
  it('lets exactly one of several parallel checks claim the badge check', async () => {
    const saved = await pendingBadge()
    const claims = await Promise.allSettled(
      Array.from({ length: 8 }, () => operations().claimVerification(saved.id, OWNER))
    )
    const won = claims.filter(claim => claim.status === 'fulfilled')
    expect(won).toHaveLength(1)
    for (const claim of claims) {
      if (claim.status === 'rejected') {
        expect(claim.reason).toMatchObject({ code: 'cooldown', status: 429 })
      }
    }
    const [winner] = won as Array<PromiseFulfilledResult<{ claimedAt: string }>>
    expect(winner?.value.claimedAt).toBe('2026-08-01 00:00:00')
    await expect(
      operations().finishVerification(saved.id, OWNER, winner?.value.claimedAt ?? '', {
        code: 'badge_missing',
        ok: false
      })
    ).resolves.toMatchObject({ verificationAttempts: 1 })
    // A result for a stale claim is refused with 409, never a 500.
    await expect(
      operations().finishVerification(saved.id, OWNER, '2026-07-31 23:59:00', { ok: true })
    ).rejects.toMatchObject({ code: 'verification_superseded', status: 409 })
    expect(
      sqlite.database
        .prepare(
          `SELECT COUNT(*) AS count FROM listing_submission_events
          WHERE submission_id=? AND event_type IN ('verification_failed','badge_verified')`
        )
        .get(saved.id)
    ).toEqual({ count: 1 })
  })

  it('verifies the badge only for the owner of a pending-badge submission', async () => {
    const saved = await draft()
    // A draft has no badge step yet.
    await expect(operations().claimVerification(saved.id, OWNER)).rejects.toMatchObject({
      code: 'not_pending_badge',
      status: 409
    })
    await operations().chooseFreePlan(saved.id, OWNER)
    await expect(operations().claimVerification(saved.id, OTHER)).rejects.toMatchObject({
      code: 'not_found',
      status: 404
    })
    const { claimedAt } = await operations().claimVerification(saved.id, OWNER)
    await expect(
      operations().finishVerification(saved.id, OTHER, claimedAt, { ok: true })
    ).rejects.toMatchObject({ code: 'verification_superseded' })
    const verified = await operations().finishVerification(saved.id, OWNER, claimedAt, {
      ok: true
    })
    expect(verified).toMatchObject({ plan: 'free', status: 'verified', verificationAttempts: 1 })
    expect(verified.badgeVerifiedAt).toBe('2026-08-01 00:00:00')
    now = new Date(now.getTime() + 60_000)
    await expect(operations().claimVerification(saved.id, OWNER)).rejects.toMatchObject({
      code: 'not_pending_badge'
    })
  })

  it('enforces the cooldown and attempt limit, and keeps transient failures free', async () => {
    const saved = await pendingBadge()
    const transient = await check(saved.id, { code: 'site_unreachable', ok: false })
    expect(sqlite.statements.some(statement => /\bTEMP\b/iu.test(statement.sql))).toBe(false)
    expect(transient).toMatchObject({
      lastVerificationAt: '2026-08-01 00:00:00',
      lastVerificationError: 'site_unreachable',
      verificationAttempts: 0
    })
    // A transient failure still starts the cooldown: every fetch is claimed.
    now = new Date(now.getTime() + 29_000)
    await expect(operations().claimVerification(saved.id, OWNER)).rejects.toMatchObject({
      code: 'cooldown',
      status: 429
    })
    now = new Date(now.getTime() + 1_000)
    await expect(check(saved.id, { code: 'nofollow', ok: false })).resolves.toMatchObject({
      verificationAttempts: 1
    })

    // Every conclusive result counts toward the limit, including the code stored before #84.
    for (const code of [
      'link_not_followed',
      'page_not_followed',
      'nofollow',
      'badge_missing',
      'wrong_destination'
    ]) {
      sqlite.database
        .prepare(
          'UPDATE listing_submissions SET verification_attempts=10,last_verification_error=?,last_verification_at=NULL WHERE id=?'
        )
        .run(code, saved.id)
      await expect(operations().claimVerification(saved.id, OWNER), code).rejects.toMatchObject({
        code: 'attempt_limit',
        status: 429
      })
    }
    // After the tenth miss, a connection problem does not pause checks.
    sqlite.database
      .prepare("UPDATE listing_submissions SET last_verification_error='fetch_timeout' WHERE id=?")
      .run(saved.id)
    await expect(operations().claimVerification(saved.id, OWNER)).resolves.toMatchObject({
      submission: { verificationAttempts: 10 }
    })
  })

  it('counts unfollowed badge links and pages as conclusive checks', async () => {
    const saved = await pendingBadge()
    await expect(check(saved.id, { code: 'link_not_followed', ok: false })).resolves.toMatchObject({
      lastVerificationError: 'link_not_followed',
      status: 'pending_badge',
      verificationAttempts: 1
    })
    now = new Date(now.getTime() + 30_000)
    await expect(check(saved.id, { code: 'page_not_followed', ok: false })).resolves.toMatchObject({
      verificationAttempts: 2
    })
  })

  it('limits draft saves per fingerprint in a fixed window and stores only digests', async () => {
    for (let request = 0; request < 10; request += 1) {
      await operations().consumeRateLimit(`user:${OWNER}`)
    }
    await expect(operations().consumeRateLimit(`user:${OWNER}`)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429
    })
    await expect(operations().consumeRateLimit(`user:${OTHER}`)).resolves.toBeUndefined()
    expect(
      sqlite.database
        .prepare(
          'SELECT fingerprint_hash,request_count FROM listing_submission_rate_limits ORDER BY request_count'
        )
        .all()
    ).toEqual([
      { fingerprint_hash: await hash(`user:${OTHER}`), request_count: 1 },
      { fingerprint_hash: await hash(`user:${OWNER}`), request_count: 11 }
    ])
    now = new Date(now.getTime() + 60 * 60 * 1000)
    await expect(operations().consumeRateLimit(`user:${OWNER}`)).resolves.toBeUndefined()
  })
})

describe('submission review preview', () => {
  const row = {
    category_slug: 'tools',
    content: input.content,
    created_at: '2026-08-01 00:00:00',
    description: input.description,
    id: '11111111-1111-4111-8111-111111111111',
    logo_url: input.logoUrl,
    name: input.name,
    slug: 'example.com',
    video_url: null,
    website: input.website
  }
  const resources = [
    { label: 'Docs', sort_order: 0, url: 'https://example.com/docs' },
    { label: 'Support', sort_order: 1, url: 'https://example.com/support' }
  ]

  it('maps the staged row and its resource links, with an optional long description', () => {
    expect(buildSubmissionReviewPreview(row, resources)).toMatchObject({
      category: 'tools',
      content: input.content,
      resourceLinks: [
        { label: 'Docs', url: 'https://example.com/docs' },
        { label: 'Support', url: 'https://example.com/support' }
      ],
      slug: 'example.com'
    })
    expect(buildSubmissionReviewPreview({ ...row, content: '' }, resources)).toMatchObject({
      content: ''
    })
  })

  it('fails closed when the staged row contains malformed fields', () => {
    const rows = [
      { category_slug: '' },
      { description: ' ' },
      { name: ' ' },
      { slug: ' ' },
      { website: 'not a URL' },
      { website: 'javascript:alert(1)' },
      { website: 'http://127.0.0.1/private' },
      { logo_url: 'not an asset' },
      { video_url: 'not an asset' },
      { created_at: 'invalid' }
    ]
    for (const corruption of rows) {
      expect(() => buildSubmissionReviewPreview({ ...row, ...corruption }, resources)).toThrow(
        /Invalid D1 submission preview/u
      )
    }
    const links = [
      { label: ' ' },
      { url: 'not a URL' },
      { url: 'file:///tmp/private' },
      { url: 'http://169.254.169.254/latest' }
    ]
    for (const corruption of links) {
      expect(() =>
        buildSubmissionReviewPreview(row, [{ ...resources[0], ...corruption }, resources[1]])
      ).toThrow(/Invalid D1 submission preview/u)
    }
  })
})
