import { beforeEach, describe, expect, it } from 'vitest'
import { type AccountOperations, createAccountOperations } from './account'
import { createDatabase } from './client'
import { insertPublishedListing, SqliteD1 } from './test-support'

/**
 * The submitter dashboard's reads and writes (#65) over node:sqlite through the D1 adapter:
 * every read and write is the signed-in user's own, and each write is a reviewed plan.
 */

const OWNER = 'user_owner'
const OTHER = 'user_other'
const NOW = '2026-10-06T12:00:00.000Z'

const content = {
  categorySlug: 'tools',
  content: 'What it does, at length.',
  description: 'A plain description of the product.',
  logoUrl: 'https://quillmate.app/logo.png',
  name: 'Quillmate'
}

describe('account operations', () => {
  let sqlite: SqliteD1
  let now: Date

  beforeEach(() => {
    now = new Date(NOW)
    sqlite = new SqliteD1()
    sqlite.database.exec(`
      INSERT INTO categories(id,slug,name,description,sort_order,is_active) VALUES
        (1,'tools','Tools','Tools',0,1), (2,'apps','Apps','Apps',1,1),
        (3,'retired','Retired','Retired',2,0);
      INSERT INTO publication_state(id,version,checksum,published_at)
        VALUES (1,1,'before','2026-01-01T00:00:00.000Z');
      INSERT INTO users(id,name,email,email_verified) VALUES
        ('${OWNER}','','owner@example.com',1), ('${OTHER}','','other@example.com',1);
    `)
  })

  function operations(): AccountOperations {
    return createAccountOperations({
      client: createDatabase(sqlite.asD1Database()),
      clock: () => now
    })
  }

  function seedSubmission(
    id: string,
    status: string,
    options: { listingId?: string; owner?: string; paid?: boolean; slug?: string } = {}
  ): void {
    const slug = options.slug ?? `${id}.example`
    sqlite.database
      .prepare(
        `INSERT INTO listing_submissions (id,slug,block_key,block_covers_subdomains,name,
          description,website,content,category_slug,logo_url,status,plan,owner_user_id,
          badge_verified_at,verification_attempts,listing_id,paid_at,reviewer_note,draft_saved_at)
        VALUES (?,?,?,1,'Quillmate','Writes copy.',?,'Long','tools',?,?,?,?,?,1,?,?,?,?)`
      )
      .run(
        id,
        slug,
        slug,
        `https://${slug}/`,
        `https://${slug}/logo.png`,
        status,
        status === 'draft' ? null : options.paid ? 'paid' : 'free',
        options.owner ?? OWNER,
        status === 'draft' ? null : '2026-10-01T00:00:00.000Z',
        options.listingId ?? null,
        options.paid ? '2026-10-01T00:00:00.000Z' : null,
        status === 'changes_requested' ? 'Describe it plainly.' : null,
        status === 'draft' ? '2026-10-05T00:00:00.000Z' : null
      )
    sqlite.database
      .prepare(
        `INSERT INTO listing_submission_faqs (submission_id,question,answer,sort_order)
        VALUES (?,'Is it free?','Yes.',0)`
      )
      .run(id)
  }

  /** A live listing its owner submitted (free unless `paid`), as an approval leaves it. */
  function seedOwnedListing(
    id: string,
    options: { owner?: string; paid?: boolean; slug?: string } = {}
  ): string {
    const slug = options.slug ?? `${id}.example`
    insertPublishedListing(sqlite.database, {
      categoryIds: [1],
      content: 'Live content',
      description: 'Live description',
      displayOrder: 0,
      id,
      isFeatured: false,
      name: `Live ${id}`,
      publishedAt: '2026-09-01',
      slug,
      website: `https://${slug}/`
    })
    sqlite.database.exec(`
      INSERT INTO listing_media (listing_id,kind,url,sort_order)
        VALUES ('${id}','logo','https://${slug}/logo.png',0);
      INSERT INTO listing_faqs (listing_id,question,answer,sort_order)
        VALUES ('${id}','Old question','Old answer',0);
      INSERT INTO listing_owners (listing_id,user_id,role,verified_via,verified_at)
        VALUES ('${id}','${options.owner ?? OWNER}','owner','submission','2026-09-01T00:00:00.000Z');
    `)
    seedSubmission(`sub_${id}`, 'approved', {
      listingId: id,
      owner: options.owner ?? OWNER,
      paid: options.paid,
      slug
    })
    return slug
  }

  function row(sql: string, ...params: string[]): Record<string, unknown> | undefined {
    return sqlite.database.prepare(sql).get(...params) as Record<string, unknown> | undefined
  }

  it('reads only the user’s own submissions and listings', async () => {
    seedSubmission('sub_mine', 'verified')
    seedSubmission('sub_theirs', 'verified', { owner: OTHER })
    seedOwnedListing('lst_mine')
    seedOwnedListing('lst_theirs', { owner: OTHER })

    const mine = await operations().overview(OWNER)
    expect(mine.submissions.map(submission => submission.id).sort()).toEqual([
      'sub_lst_mine',
      'sub_mine'
    ])
    expect(mine.listings.map(listing => listing.id)).toEqual(['lst_mine'])
    expect(mine.listings[0]).toMatchObject({
      badge: { checksInWindow: 0, submissionId: 'sub_lst_mine' },
      live: true,
      plan: 'free',
      submission: { id: 'sub_lst_mine', status: 'approved' }
    })

    expect(await operations().submission(OWNER, 'sub_theirs')).toBeNull()
    expect(await operations().listing(OWNER, 'lst_theirs.example')).toBeNull()
    expect(await operations().submission(OWNER, 'sub_mine')).toMatchObject({
      faqs: [{ answer: 'Yes.', question: 'Is it free?' }],
      status: 'verified'
    })
    expect(await operations().listing(OWNER, 'lst_mine.example')).toMatchObject({
      faqs: [{ answer: 'Old answer', question: 'Old question' }],
      logoUrl: 'https://lst_mine.example/logo.png'
    })

    // A revoked owner no longer sees the listing.
    sqlite.database.exec(
      "UPDATE listing_owners SET revoked_at='2026-10-06T00:00:00.000Z', revoked_reason='transferred' WHERE listing_id='lst_mine'"
    )
    expect((await operations().overview(OWNER)).listings).toEqual([])
  })

  it('offers Relist for a listing the badge program unlisted, never one filed under a retired category (#260)', async () => {
    for (const id of ['lst_gone', 'lst_retired']) {
      seedOwnedListing(id)
      sqlite.database.exec(`
        UPDATE listings SET is_active=0 WHERE id='${id}';
        INSERT INTO listing_submission_events (submission_id,event_type,detail,actor)
          VALUES ('sub_${id}','unpublished','badge_missing','badge-program');
      `)
    }
    // Filed under the retired category once unpublished, as the adult removal leaves a listing.
    sqlite.database.exec(`INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
      VALUES ('lst_retired',3,1,0)`)
    const listings = new Map(
      (await operations().overview(OWNER)).listings.map(listing => [listing.id, listing])
    )
    expect(listings.get('lst_gone')).toMatchObject({ checkoutPurpose: 'relist', live: false })
    expect(listings.get('lst_retired')).toMatchObject({ checkoutPurpose: null, live: false })
    expect(await operations().listing(OWNER, 'lst_retired.example')).toMatchObject({
      checkoutPurpose: null
    })
  })

  it('withdraws only the owner’s unpaid submission, once', async () => {
    seedSubmission('sub_open', 'verified')
    seedSubmission('sub_paid', 'verified', { paid: true })
    await expect(
      operations().withdrawSubmission({ submissionId: 'sub_open', userId: OTHER })
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await operations().withdrawSubmission({ submissionId: 'sub_open', userId: OWNER })
    expect(
      row("SELECT status,withdrawal_reason FROM listing_submissions WHERE id='sub_open'")
    ).toEqual({ status: 'withdrawn', withdrawal_reason: 'owner' })
    await expect(
      operations().withdrawSubmission({ submissionId: 'sub_open', userId: OWNER })
    ).rejects.toMatchObject({ code: 'not_withdrawable' })
    await expect(
      operations().withdrawSubmission({ submissionId: 'sub_paid', userId: OWNER })
    ).rejects.toMatchObject({ code: 'not_withdrawable', status: 409 })
  })

  it('resubmits a changes-requested submission with its edits, keeping its FAQs', async () => {
    seedSubmission('sub_fix', 'changes_requested')
    await expect(
      operations().resubmitSubmission({
        content,
        expectedContentVersion: 1,
        submissionId: 'sub_fix',
        userId: OTHER
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      operations().resubmitSubmission({
        content: { ...content, categorySlug: 'retired' },
        expectedContentVersion: 1,
        submissionId: 'sub_fix',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'invalid_category' })
    await expect(
      operations().resubmitSubmission({
        content,
        expectedContentVersion: 7,
        submissionId: 'sub_fix',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'stale_submission', status: 409 })

    const updated = await operations().resubmitSubmission({
      content: {
        ...content,
        content: 'Long',
        description: 'Turns notes into landing pages.',
        logoUrl: 'https://sub_fix.example/logo.png'
      },
      expectedContentVersion: 1,
      submissionId: 'sub_fix',
      userId: OWNER
    })
    expect(updated).toMatchObject({
      contentVersion: 2,
      description: 'Turns notes into landing pages.',
      faqs: [{ answer: 'Yes.', question: 'Is it free?' }],
      status: 'verified'
    })
    expect(
      updated.events
        .map(event => event.type)
        .slice(0, 2)
        .sort()
    ).toEqual(['edited', 'resubmitted'])
    expect(updated.events.find(event => event.type === 'edited')?.detail).toBe(
      JSON.stringify({ fields: ['description'] })
    )
    await expect(
      operations().resubmitSubmission({
        content,
        expectedContentVersion: 2,
        submissionId: 'sub_fix',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'not_editable' })
  })

  it('adds FAQs and links while a submission waits for review, and nowhere else', async () => {
    seedSubmission('sub_review', 'verified')
    seedSubmission('sub_draft', 'draft')
    const extras = {
      faqs: [{ answer: ' No. ', question: ' Does it file taxes? ' }],
      resourceLinks: [{ label: 'Pricing', url: 'https://quillmate.app/pricing' }]
    }
    const saved = await operations().saveSubmissionExtras({
      expectedContentVersion: 1,
      extras,
      submissionId: 'sub_review',
      userId: OWNER
    })
    expect(saved).toMatchObject({
      contentVersion: 2,
      faqs: [{ answer: 'No.', question: 'Does it file taxes?' }],
      resourceLinks: [{ label: 'Pricing', url: 'https://quillmate.app/pricing' }],
      status: 'verified'
    })
    await expect(
      operations().saveSubmissionExtras({
        expectedContentVersion: 1,
        extras,
        submissionId: 'sub_review',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'stale_submission' })
    await expect(
      operations().saveSubmissionExtras({
        expectedContentVersion: 1,
        extras,
        submissionId: 'sub_draft',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'not_editable' })
    await expect(
      operations().saveSubmissionExtras({
        expectedContentVersion: 2,
        extras: { faqs: [], resourceLinks: [{ label: 'Docs', url: 'http://quillmate.app/' }] },
        submissionId: 'sub_review',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'invalid_links' })
    await expect(
      operations().saveSubmissionExtras({
        expectedContentVersion: 2,
        extras,
        submissionId: 'sub_review',
        userId: OTHER
      })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('stages live-listing edits as one open revision the owner can change, discard, or fix', async () => {
    const slug = seedOwnedListing('lst_edit')
    const listing = await operations().listing(OWNER, slug)
    if (!listing) throw new Error('fixture listing missing')
    const edit = {
      categorySlug: 'apps',
      content: 'New long content',
      description: 'New description',
      faqs: [{ answer: 'Yes.', question: 'Bank feeds?' }],
      logoUrl: listing.logoUrl ?? '',
      resourceLinks: [{ label: 'Docs', url: 'https://lst_edit.example/docs' }]
    }
    await expect(
      operations().saveRevision({
        content: edit,
        expectedRevisionVersion: null,
        listingId: 'lst_edit',
        newRevisionId: 'rev_x',
        userId: OTHER
      })
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(
      await operations().saveRevision({
        content: edit,
        expectedRevisionVersion: null,
        listingId: 'lst_edit',
        newRevisionId: 'rev_1',
        userId: OWNER
      })
    ).toEqual({ queued: true, revisionId: 'rev_1' })
    // Saving again changes the open revision instead of opening another.
    expect(
      await operations().saveRevision({
        content: { ...edit, description: 'Changed again' },
        expectedRevisionVersion: 1,
        listingId: 'lst_edit',
        newRevisionId: 'rev_2',
        userId: OWNER
      })
    ).toEqual({ queued: false, revisionId: 'rev_1' })
    const staged = await operations().listing(OWNER, slug)
    expect(staged?.revision).toMatchObject({
      categorySlug: 'apps',
      contentVersion: 2,
      description: 'Changed again',
      faqs: [{ answer: 'Yes.', question: 'Bank feeds?' }],
      name: 'Live lst_edit',
      status: 'pending_review'
    })
    // The live listing is untouched until a reviewer approves.
    expect(staged?.description).toBe('Live description')

    // A stale tab (it loaded version 1, or no revision at all) is refused, never applied.
    for (const expectedRevisionVersion of [1, null]) {
      await expect(
        operations().saveRevision({
          content: { ...edit, description: 'From a stale tab' },
          expectedRevisionVersion,
          listingId: 'lst_edit',
          newRevisionId: 'rev_stale',
          userId: OWNER
        })
      ).rejects.toMatchObject({ code: 'stale_revision', status: 409 })
    }
    // Two tabs loaded version 2: the first save wins, the second gets 409 (the Playwright
    // suite sends them in parallel to the Worker).
    const save = (tab: string) =>
      operations().saveRevision({
        content: { ...edit, description: `Tab ${tab}` },
        expectedRevisionVersion: 2,
        listingId: 'lst_edit',
        newRevisionId: `rev_${tab}`,
        userId: OWNER
      })
    await save('A')
    await expect(save('B')).rejects.toMatchObject({ code: 'stale_revision' })
    expect(row("SELECT description FROM listing_revisions WHERE id='rev_1'")).toEqual({
      description: 'Tab A'
    })
    expect(row("SELECT content_version FROM listing_revisions WHERE id='rev_1'")).toEqual({
      content_version: 3
    })

    // A reviewer asks for changes; saving fixes and resubmits it.
    sqlite.database.exec(
      "UPDATE listing_revisions SET status='changes_requested', reviewer_note='Shorter' WHERE id='rev_1'"
    )
    expect(
      await operations().saveRevision({
        content: edit,
        expectedRevisionVersion: 3,
        listingId: 'lst_edit',
        newRevisionId: 'rev_3',
        userId: OWNER
      })
    ).toEqual({ queued: true, revisionId: 'rev_1' })
    expect(row("SELECT status FROM listing_revisions WHERE id='rev_1'")).toEqual({
      status: 'pending_review'
    })

    await expect(
      operations().saveRevision({
        content: { ...edit, logoUrl: 'http://lst_edit.example/new.png' },
        expectedRevisionVersion: 4,
        listingId: 'lst_edit',
        newRevisionId: 'rev_4',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'invalid_logo' })

    await operations().discardRevision({ listingId: 'lst_edit', userId: OWNER })
    expect(row("SELECT status FROM listing_revisions WHERE id='rev_1'")).toEqual({
      status: 'withdrawn'
    })
    await expect(
      operations().discardRevision({ listingId: 'lst_edit', userId: OWNER })
    ).rejects.toMatchObject({ code: 'no_open_revision' })
  })

  it('stages tags with a revision only when they differ from the listing’s (#341)', async () => {
    const slug = seedOwnedListing('lst_tags')
    sqlite.database.exec(`
      INSERT INTO tags (slug,name,category_id,sort_order,is_active) VALUES
        ('note-taking','Note Taking',1,0,1),('whiteboards','Whiteboards',2,0,1),
        ('gone','Gone',1,1,1);
      INSERT INTO listing_tags (listing_id,tag_id,sort_order)
        SELECT 'lst_tags',id,0 FROM tags WHERE slug='note-taking';
      INSERT INTO listing_tags (listing_id,tag_id,sort_order)
        SELECT 'lst_tags',id,1 FROM tags WHERE slug='gone';
      UPDATE tags SET is_active=0 WHERE slug='gone';
    `)
    const listing = await operations().listing(OWNER, slug)
    // Only active tags show: a retired one isn't the owner's to keep or drop.
    expect(listing?.tags).toEqual(['note-taking'])
    const edit = {
      categorySlug: 'tools',
      content: 'Live content',
      description: 'Live description',
      faqs: [],
      logoUrl: listing?.logoUrl ?? '',
      resourceLinks: []
    }
    const save = (tagSlugs: string[] | undefined, expectedRevisionVersion: number | null) =>
      operations().saveRevision({
        content: { ...edit, tagSlugs },
        expectedRevisionVersion,
        listingId: 'lst_tags',
        newRevisionId: 'rev_tags',
        userId: OWNER
      })
    const stored = () => row("SELECT tag_slugs FROM listing_revisions WHERE id='rev_tags'")
    await save(['note-taking'], null)
    expect(stored()).toEqual({ tag_slugs: null })
    await save(['whiteboards', 'note-taking'], 1)
    expect(stored()).toEqual({ tag_slugs: '["whiteboards","note-taking"]' })
    expect((await operations().listing(OWNER, slug))?.revision?.tagSlugs).toEqual([
      'whiteboards',
      'note-taking'
    ])
    await save(undefined, 2)
    expect(stored()).toEqual({ tag_slugs: null })
    await save([], 3)
    expect(stored()).toEqual({ tag_slugs: '[]' })
    for (const tagSlugs of [['gone'], ['nope'], ['whiteboards', 'whiteboards']]) {
      await expect(save(tagSlugs, 4)).rejects.toMatchObject({ code: 'invalid_tags' })
    }
  })

  it('checks a live free listing’s badge with its own cooldown and 24-hour budget', async () => {
    seedOwnedListing('lst_badge')
    seedOwnedListing('lst_paid', { paid: true })
    await expect(
      operations().claimListingBadgeCheck({ listingId: 'lst_paid', userId: OWNER })
    ).rejects.toMatchObject({ code: 'not_checkable' })
    await expect(
      operations().claimListingBadgeCheck({ listingId: 'lst_badge', userId: OTHER })
    ).rejects.toMatchObject({ code: 'not_found' })
    // The badge step used all ten of its checks: the panel has its own budget anyway.
    sqlite.database.exec(
      "UPDATE listing_submissions SET verification_attempts=10, last_verification_error='badge_missing' WHERE id='sub_lst_badge'"
    )

    const check = async (result: { ok: true } | { code: string; ok: false }) => {
      const { claimedAt } = await operations().claimListingBadgeCheck({
        listingId: 'lst_badge',
        userId: OWNER
      })
      await operations().finishListingBadgeCheck({
        claimedAt,
        result,
        submissionId: 'sub_lst_badge',
        userId: OWNER
      })
      now = new Date(now.getTime() + 31_000)
    }
    const { claimedAt } = await operations().claimListingBadgeCheck({
      listingId: 'lst_badge',
      userId: OWNER
    })
    await expect(
      operations().claimListingBadgeCheck({ listingId: 'lst_badge', userId: OWNER })
    ).rejects.toMatchObject({ code: 'cooldown', status: 429 })
    await operations().finishListingBadgeCheck({
      claimedAt,
      result: { code: 'link_not_followed', ok: false },
      submissionId: 'sub_lst_badge',
      userId: OWNER
    })
    now = new Date(now.getTime() + 31_000)
    // A record of a claim that was overtaken is refused.
    await expect(
      operations().finishListingBadgeCheck({
        claimedAt: '2026-10-06 11:00:00',
        result: { ok: true },
        submissionId: 'sub_lst_badge',
        userId: OWNER
      })
    ).rejects.toMatchObject({ code: 'verification_superseded' })

    let listing = await operations().listing(OWNER, 'lst_badge.example')
    expect(listing?.badge).toMatchObject({
      checksInWindow: 1,
      history: [
        {
          by: 'owner',
          conclusive: true,
          fromPanel: true,
          outcome: 'fail',
          reason: 'link_not_followed'
        }
      ],
      lastError: 'link_not_followed'
    })
    // The badge step's counter is left alone, and the program's table is never written.
    expect(
      row("SELECT verification_attempts FROM listing_submissions WHERE id='sub_lst_badge'")
    ).toEqual({
      verification_attempts: 10
    })
    expect(row('SELECT COUNT(*) AS count FROM badge_checks')).toEqual({ count: 0 })

    // A connection problem doesn't count; nine more results reach the budget of ten.
    await check({ code: 'fetch_timeout', ok: false })
    for (let index = 0; index < 9; index += 1) await check({ ok: true })
    listing = await operations().listing(OWNER, 'lst_badge.example')
    expect(listing?.badge?.checksInWindow).toBe(10)
    await expect(
      operations().claimListingBadgeCheck({ listingId: 'lst_badge', userId: OWNER })
    ).rejects.toMatchObject({ code: 'attempt_limit', status: 429 })
    // The budget refills as checks leave the 24-hour window.
    now = new Date(Date.parse(NOW) + 24 * 60 * 60 * 1000 + 40_000)
    await expect(
      operations().claimListingBadgeCheck({ listingId: 'lst_badge', userId: OWNER })
    ).resolves.toMatchObject({ claimedAt: expect.any(String) })
  })
})
