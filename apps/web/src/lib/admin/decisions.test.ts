/**
 * Every admin decision (#64) on node:sqlite with the checked-in migrations: approvals publish,
 * replays write nothing and only retry their email (the ledger sends it once), stale views
 * answer 409 while a lost publication race is retried, rejections block, refuse, or keep the
 * refund pending as the category requires, listing actions log, and the allowlist never loses
 * its last admin.
 */

import { describe, expect, it, vi } from 'vitest'
import { createAdminReadOperations } from '@/db/admin-queries'
import { createDatabase } from '@/db/client'
import { insertPublishedListing, SqliteD1 } from '@/db/test-support'
import {
  type AdminContext,
  addAdmin,
  allowResubmission,
  approveRevision,
  approveSubmission,
  rejectRevision,
  rejectSubmission,
  removeAdmin,
  removeListingOwner,
  republishListing,
  requestSubmissionChanges,
  setListingLinkRel,
  setListingTags,
  transferListingOwner,
  unpublishListing,
  updateListingDetails
} from './decisions'

const NOW = new Date('2026-10-06T12:00:00.000Z')

function fixture() {
  const sqlite = new SqliteD1()
  const db = sqlite.database
  db.exec(`
    INSERT INTO categories (slug, name, sort_order) VALUES ('tools', 'Tools', 0), ('apps', 'Apps', 1);
    INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'before');
    INSERT INTO users (id, name, email, email_verified)
      VALUES ('user_maya', 'Maya', 'maya@example.com', 1),
        ('user_priya', 'Priya', 'priya@example.com', 1);
  `)
  insertPublishedListing(db, {
    categoryIds: [1],
    content: 'Content',
    description: 'Brieflow description',
    displayOrder: 0,
    id: 'lst_brief',
    isFeatured: false,
    name: 'Brieflow',
    publishedAt: '2026-05-16',
    slug: 'brieflow.ai',
    website: 'https://brieflow.ai/'
  })
  db.exec(`
    UPDATE listings SET checksum = 'brief-checksum' WHERE id = 'lst_brief';
    INSERT INTO listing_media (listing_id, kind, url, sort_order)
      VALUES ('lst_brief', 'logo', 'https://assets.example/brief.png', 0);
  `)
  const submission = (id: string, slug: string, status: string) =>
    db.exec(`
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, owner_user_id, badge_verified_at, block_key,
        block_covers_subdomains)
      VALUES ('${id}', '${slug}', 'Name ${id}', 'Short ${id}', 'https://${slug}/', 'Long ${id}',
        'tools', 'https://${slug}/logo.png', '${status}', 'free', 'user_maya',
        '2026-10-06T07:00:00.000Z', '${slug}', 1)`)
  /** A paid submission published before review on the fixture's live listing. */
  const paidLive = (id: string) =>
    db.exec(`
      INSERT INTO listing_submissions (id, slug, name, description, website, content,
        category_slug, logo_url, status, plan, paid_at, listing_id, published_checksum,
        owner_user_id, block_key, block_covers_subdomains)
      VALUES ('${id}', 'brieflow.ai', 'Name ${id}', 'Short ${id}', 'https://brieflow.ai/',
        'Long ${id}', 'tools', 'https://brieflow.ai/logo.png', 'paid_pending_review', 'paid',
        '2026-10-06T08:00:00.000Z', 'lst_brief', 'brief-checksum', 'user_maya', 'brieflow.ai', 1)`)
  const emails: Array<{ eventKey: string; input: unknown; template: string; to: string }> = []
  const context = (overrides: Partial<AdminContext> = {}): AdminContext => ({
    actor: 'devin@serp.co',
    client: createDatabase(sqlite.asD1Database()),
    eventKey: (event, ...ids) => [event, ...ids].join(':'),
    notify: vi.fn(async (template, request) => {
      emails.push({ ...request, template })
    }) as AdminContext['notify'],
    now: () => NOW,
    ...overrides
  })
  const row = (sql: string, ...params: unknown[]) =>
    db.prepare(sql).get(...(params as string[])) as Record<string, unknown> | undefined
  /**
   * A client whose next write batches each first publish something else (another admin's
   * decision on a different listing), so the decision's batch loses the race for the
   * publication version. Read batches pass through.
   */
  const racingClient = (races = 1, alsoChange = '') => {
    const d1 = sqlite.asD1Database()
    const sqlOf = new WeakMap<object, string>()
    const prepare = d1.prepare.bind(d1)
    d1.prepare = sql => {
      const statement = prepare(sql)
      sqlOf.set(statement, sql)
      return statement
    }
    const batch = d1.batch.bind(d1)
    let left = races
    d1.batch = async statements => {
      const writes = statements.some(statement =>
        /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sqlOf.get(statement) ?? '')
      )
      if (writes && left > 0) {
        left -= 1
        db.exec(
          "UPDATE publication_state SET version = version + 1, checksum = 'elsewhere-' || version"
        )
        if (alsoChange) db.exec(alsoChange)
      }
      return batch(statements)
    }
    return createDatabase(d1)
  }
  return { context, db, emails, paidLive, racingClient, row, submission }
}

describe('submission decisions', () => {
  it('approves with edits and a chosen link, emails once, and answers a replay as a no-op', async () => {
    const { context, emails, row, submission } = fixture()
    submission('sub_quill', 'quillmate.app', 'verified')
    const approve = () =>
      approveSubmission(context(), {
        edits: { description: 'Edited short description.', name: 'Quillmate' },
        expectedContentVersion: 1,
        linkRel: 'follow',
        submissionId: 'sub_quill'
      })
    expect(await approve()).toEqual({
      listingSlug: 'quillmate.app',
      ok: true,
      replayed: false
    })
    expect(row("SELECT * FROM listings WHERE slug='quillmate.app'")).toMatchObject({
      description: 'Edited short description.',
      id: 'submission_sub_quill',
      is_active: 1,
      link_rel: 'follow',
      name: 'Quillmate',
      source: 'submission',
      status: 'approved'
    })
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(row("SELECT detail FROM listing_submission_events WHERE event_type='edited'")).toEqual({
      detail: JSON.stringify({ fields: ['name', 'description'] })
    })
    expect(emails).toEqual([
      {
        eventKey: 'submission-approved:sub_quill',
        input: {
          listingName: 'Quillmate',
          listingSlug: 'quillmate.app',
          website: 'https://quillmate.app/'
        },
        template: 'listing-approved',
        to: 'maya@example.com'
      }
    ])
    // A replay (double click, retry) writes nothing. It hands the same email to the ledger
    // under the same event key, which sends it only if the first send failed.
    expect(await approve()).toEqual({ listingSlug: 'quillmate.app', ok: true, replayed: true })
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(emails).toHaveLength(2)
    expect(emails[1]).toEqual(emails[0])
  })

  it('retries once when another publication won the race, and refuses a real change', async () => {
    const { context, racingClient, row, submission } = fixture()
    submission('sub_quill', 'quillmate.app', 'verified')
    // Another admin publishes a different listing between this read and this batch.
    expect(
      await approveSubmission(context({ client: racingClient() }), {
        expectedContentVersion: 1,
        submissionId: 'sub_quill'
      })
    ).toEqual({ listingSlug: 'quillmate.app', ok: true, replayed: false })
    expect(row("SELECT status FROM listing_submissions WHERE id='sub_quill'")).toEqual({
      status: 'approved'
    })
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 3 })

    // It retries once: losing the race twice answers 409.
    submission('sub_brief', 'brief.example', 'verified')
    expect(
      await approveSubmission(context({ client: racingClient(2) }), {
        expectedContentVersion: 1,
        submissionId: 'sub_brief'
      })
    ).toMatchObject({ error: 'conflict', status: 409 })

    // A listing decision retries the same way.
    expect(
      await setListingLinkRel(context({ client: racingClient() }), {
        linkRel: 'sponsored',
        listingId: 'lst_brief'
      })
    ).toEqual({ ok: true, replayed: false })
    expect(row("SELECT link_rel FROM listings WHERE id='lst_brief'")).toEqual({
      link_rel: 'sponsored'
    })

    // When the item itself changed in the meantime too, there is no retry: 409.
    expect(
      await unpublishListing(
        context({
          client: racingClient(1, "UPDATE listings SET checksum = 'edited' WHERE id = 'lst_brief'")
        }),
        { listingId: 'lst_brief' }
      )
    ).toMatchObject({ error: 'conflict', status: 409 })
    expect(row("SELECT is_active FROM listings WHERE id='lst_brief'")).toEqual({ is_active: 1 })
  })

  it('refuses an approval of content that changed since the reviewer opened it', async () => {
    const { context, db, submission } = fixture()
    submission('sub_quill', 'quillmate.app', 'verified')
    db.exec("UPDATE listing_submissions SET content_version = 2 WHERE id = 'sub_quill'")
    expect(
      await approveSubmission(context(), { expectedContentVersion: 1, submissionId: 'sub_quill' })
    ).toMatchObject({ error: 'conflict', ok: false, status: 409 })
    expect(
      await approveSubmission(context(), { expectedContentVersion: 1, submissionId: 'missing' })
    ).toMatchObject({ ok: false, status: 404 })
    expect(
      await approveSubmission(context(), {
        edits: { categorySlug: 'nope' },
        expectedContentVersion: 2,
        submissionId: 'sub_quill'
      })
    ).toMatchObject({ error: 'invalid_category', status: 422 })
  })

  it('requests changes with a note, emails each occurrence once, and replays as a no-op', async () => {
    const { context, emails, row, submission } = fixture()
    submission('sub_quill', 'quillmate.app', 'verified')
    expect(
      await requestSubmissionChanges(context(), { note: ' ', submissionId: 'sub_quill' })
    ).toMatchObject({ error: 'note_required', status: 422 })
    const send = () =>
      requestSubmissionChanges(context(), { note: 'Logo is blurry.', submissionId: 'sub_quill' })
    expect(await send()).toEqual({ ok: true, replayed: false })
    // The replay retries the same email (same event key) with the stored note.
    expect(
      await requestSubmissionChanges(context(), { note: 'Other words.', submissionId: 'sub_quill' })
    ).toEqual({ ok: true, replayed: true })
    expect(
      row("SELECT status, reviewer_note FROM listing_submissions WHERE id='sub_quill'")
    ).toEqual({ reviewer_note: 'Logo is blurry.', status: 'changes_requested' })
    const email = {
      eventKey: 'submission-changes-requested:sub_quill:1',
      input: {
        note: 'Logo is blurry.',
        submissionId: 'sub_quill',
        submissionName: 'Name sub_quill'
      },
      template: 'changes-requested',
      to: 'maya@example.com'
    }
    expect(emails).toEqual([email, email])
  })

  it('rejects as other or prohibited, blocking the domain only for prohibited', async () => {
    const { context, emails, row, submission } = fixture()
    submission('sub_other', 'other.example', 'verified')
    submission('sub_bad', 'casino.example', 'verified')
    expect(
      await rejectSubmission(context(), {
        category: 'other',
        reason: 'Waitlist only.',
        submissionId: 'sub_other'
      })
    ).toEqual({ ok: true, refundPending: false, refunded: false, replayed: false })
    expect(
      await rejectSubmission(context(), {
        category: 'prohibited',
        reason: 'Gambling without a license.',
        submissionId: 'sub_bad'
      })
    ).toEqual({ ok: true, refundPending: false, refunded: false, replayed: false })
    expect(
      await rejectSubmission(context(), {
        category: 'prohibited',
        reason: 'Again.',
        submissionId: 'sub_bad'
      })
    ).toEqual({ ok: true, refundPending: false, refunded: false, replayed: true })
    expect(
      row('SELECT url_key FROM listing_submission_url_blocks WHERE lifted_at IS NULL')
    ).toEqual({ url_key: 'casino.example' })
    // The replay retries the stored rejection's email under the same event key.
    expect(emails.map(email => [email.template, email.eventKey])).toEqual([
      ['submission-rejected', 'submission-rejected:sub_other'],
      ['submission-rejected-prohibited', 'submission-rejected:sub_bad'],
      ['submission-rejected-prohibited', 'submission-rejected:sub_bad']
    ])
    expect(emails[2]?.input).toMatchObject({ reason: 'Gambling without a license.' })
    // "Allow resubmission" acts on the submission in the path, never on a key from the body:
    // an unknown submission is 404, and a confirmed key that isn't this submission's is 409.
    expect(
      await allowResubmission(context(), { submissionId: 'sub_missing', urlKey: 'casino.example' })
    ).toMatchObject({ error: 'not_found', status: 404 })
    expect(
      await allowResubmission(context(), { submissionId: 'sub_other', urlKey: 'casino.example' })
    ).toMatchObject({ error: 'conflict', status: 409 })
    expect(
      row('SELECT COUNT(*) AS active FROM listing_submission_url_blocks WHERE lifted_at IS NULL')
    ).toEqual({ active: 1 })
    // It lifts the block once; a second click is a no-op.
    expect(
      await allowResubmission(context(), { submissionId: 'sub_bad', urlKey: 'casino.example' })
    ).toEqual({ ok: true, replayed: false })
    expect(await allowResubmission(context(), { submissionId: 'sub_bad' })).toEqual({
      ok: true,
      replayed: true
    })
    expect(row('SELECT lifted_by FROM listing_submission_url_blocks')).toEqual({
      lifted_by: 'devin@serp.co'
    })
  })

  it('allows resubmission from a listing page through its latest submission', async () => {
    const { context, paidLive, row } = fixture()
    // A listing without submissions has nothing to lift.
    expect(await allowResubmission(context(), { listingId: 'lst_brief' })).toMatchObject({
      error: 'not_blocked',
      status: 409
    })
    expect(await allowResubmission(context(), { listingId: 'lst_missing' })).toMatchObject({
      error: 'not_found',
      status: 404
    })
    paidLive('sub_paid')
    expect(
      await rejectSubmission(context(), {
        category: 'prohibited',
        reason: 'Counterfeit goods.',
        submissionId: 'sub_paid'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(
      await allowResubmission(context(), { listingId: 'lst_brief', urlKey: 'brieflow.ai' })
    ).toEqual({ ok: true, replayed: false })
    expect(row('SELECT url_key, lifted_by FROM listing_submission_url_blocks')).toEqual({
      lifted_by: 'devin@serp.co',
      url_key: 'brieflow.ai'
    })
  })

  it('unpublishes a live paid submission on rejection, and refuses a refund it cannot make', async () => {
    const { context, db, paidLive, row } = fixture()
    paidLive('sub_paid')
    expect(
      await rejectSubmission(context(), {
        category: 'other',
        reason: 'Duplicate of another listing.',
        submissionId: 'sub_paid'
      })
    ).toMatchObject({ error: 'refund_unavailable', status: 409 })
    expect(row("SELECT is_active FROM listings WHERE id='lst_brief'")).toEqual({ is_active: 1 })
    // #68's refund fails once (a provider outage): the rejection stands, the refund stays
    // pending, and a replay of the rejection retries it.
    const refundRejectedSubmission = vi
      .fn<(input: { actor: string; submissionId: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValue(undefined)
    const reject = () =>
      rejectSubmission(context({ refunds: { refundRejectedSubmission } }), {
        category: 'other',
        reason: 'Duplicate of another listing.',
        submissionId: 'sub_paid'
      })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await reject()).toEqual({
      ok: true,
      refundPending: true,
      refunded: false,
      replayed: false
    })
    error.mockRestore()
    expect(row("SELECT is_active FROM listings WHERE id='lst_brief'")).toEqual({ is_active: 0 })
    expect(
      row(
        "SELECT status, rejection_category, refunded_at FROM listing_submissions WHERE id='sub_paid'"
      )
    ).toEqual({ refunded_at: null, rejection_category: 'other', status: 'rejected' })
    expect(await reject()).toEqual({
      ok: true,
      refundPending: false,
      refunded: true,
      replayed: true
    })
    expect(refundRejectedSubmission).toHaveBeenCalledTimes(2)
    expect(refundRejectedSubmission).toHaveBeenLastCalledWith({
      actor: 'devin@serp.co',
      submissionId: 'sub_paid'
    })
    // Once #68 records the refund, a replay leaves it alone.
    db.exec(
      "UPDATE listing_submissions SET refunded_at = '2026-10-06T12:01:00.000Z' WHERE id='sub_paid'"
    )
    expect(await reject()).toEqual({
      ok: true,
      refundPending: false,
      refunded: true,
      replayed: true
    })
    expect(refundRejectedSubmission).toHaveBeenCalledTimes(2)
  })

  it('approves a live paid submission and keeps it live', async () => {
    const { context, emails, paidLive, row } = fixture()
    paidLive('sub_paid')
    expect(
      await approveSubmission(context(), { expectedContentVersion: 1, submissionId: 'sub_paid' })
    ).toEqual({ listingSlug: 'brieflow.ai', ok: true, replayed: false })
    expect(row("SELECT is_active, name FROM listings WHERE id='lst_brief'")).toEqual({
      is_active: 1,
      name: 'Name sub_paid'
    })
    expect(emails).toEqual([])
  })

  it('changes the outbound link of a live paid listing in the approval batch', async () => {
    const { context, paidLive, row } = fixture()
    paidLive('sub_paid')
    expect(
      await approveSubmission(context(), {
        expectedContentVersion: 1,
        linkRel: 'sponsored',
        submissionId: 'sub_paid'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(row("SELECT link_rel FROM listings WHERE id='lst_brief'")).toEqual({
      link_rel: 'sponsored'
    })
    // Two publications: the approval and the link change.
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 3 })
  })
})

describe('revision decisions', () => {
  it('approves, or rejects, an owner revision', async () => {
    const { context, db, row } = fixture()
    db.exec(`
      INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
        VALUES ('lst_brief', 'user_maya', 'badge_claim', '2026-09-03T00:00:00.000Z');
      INSERT INTO listing_revisions (id, listing_id, author_user_id, base_checksum, name,
        description, content, category_slug, logo_url)
      VALUES ('rev_1', 'lst_brief', 'user_maya', 'brief-checksum', 'Brieflow 2', 'New', 'New',
        'apps', 'https://assets.example/brief-2.png');`)
    expect(
      await approveRevision(context(), { expectedContentVersion: 1, revisionId: 'rev_1' })
    ).toEqual({ listingSlug: 'brieflow.ai', ok: true, replayed: false })
    expect(row("SELECT name FROM listings WHERE id='lst_brief'")).toEqual({ name: 'Brieflow 2' })
    expect(
      await approveRevision(context(), { expectedContentVersion: 1, revisionId: 'rev_1' })
    ).toMatchObject({ replayed: true })
    expect(await rejectRevision(context(), { reason: 'x', revisionId: 'rev_1' })).toMatchObject({
      error: 'not_rejectable',
      status: 409
    })
  })
})

describe('listing decisions', () => {
  it('edits details, unpublishes with a note, republishes, and sets the link, each once', async () => {
    const { context, row } = fixture()
    const details = {
      categorySlug: 'apps',
      description: 'Meeting notes for sales teams.',
      logoUrl: 'https://assets.example/brief.png',
      name: 'Brieflow',
      website: 'https://brieflow.ai/'
    }
    expect(
      await updateListingDetails(context(), {
        details,
        expectedChecksum: 'brief-checksum',
        listingId: 'lst_brief'
      })
    ).toEqual({ fields: ['category', 'description'], ok: true, replayed: false })
    // The same save again: nothing changed, so it is a no-op even with the old checksum.
    expect(
      await updateListingDetails(context(), {
        details,
        expectedChecksum: 'brief-checksum',
        listingId: 'lst_brief'
      })
    ).toEqual({ fields: [], ok: true, replayed: true })
    // A different edit from the stale checksum is refused.
    expect(
      await updateListingDetails(context(), {
        details: { ...details, name: 'Other' },
        expectedChecksum: 'brief-checksum',
        listingId: 'lst_brief'
      })
    ).toMatchObject({ error: 'conflict', status: 409 })
    expect(await unpublishListing(context(), { listingId: 'lst_brief', note: 'Rebrand' })).toEqual({
      ok: true,
      replayed: false
    })
    expect(await unpublishListing(context(), { listingId: 'lst_brief' })).toEqual({
      ok: true,
      replayed: true
    })
    expect(await republishListing(context(), { listingId: 'lst_brief' })).toEqual({
      ok: true,
      replayed: false
    })
    expect(
      await setListingLinkRel(context(), { linkRel: 'sponsored', listingId: 'lst_brief' })
    ).toEqual({ ok: true, replayed: false })
    expect(
      await setListingLinkRel(context(), { linkRel: 'sponsored', listingId: 'lst_brief' })
    ).toEqual({ ok: true, replayed: true })
    expect(row("SELECT is_active, link_rel FROM listings WHERE id='lst_brief'")).toEqual({
      is_active: 1,
      link_rel: 'sponsored'
    })
    expect(
      row(
        "SELECT group_concat(event_type) AS events FROM listing_events WHERE listing_id='lst_brief'"
      )
    ).toEqual({ events: 'edited,unpublished,republished,link_rel_changed' })
  })

  it('refuses to republish a listing filed under a retired category, and says why (#260)', async () => {
    const { context, db, row } = fixture()
    expect(await unpublishListing(context(), { listingId: 'lst_brief' })).toMatchObject({
      ok: true
    })
    db.exec(`INSERT INTO categories (slug, name) VALUES ('adult', 'Adult');
      INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
        SELECT 'lst_brief', id, 9, 0 FROM categories WHERE slug = 'adult';
      UPDATE categories SET is_active = 0 WHERE slug = 'adult';`)
    expect(await republishListing(context(), { listingId: 'lst_brief' })).toEqual({
      error: 'listing_category_retired',
      message:
        "It is filed under the retired Adult category, so it stays off the site and can't be republished.",
      ok: false,
      status: 409
    })
    expect(row("SELECT is_active FROM listings WHERE id='lst_brief'")).toEqual({ is_active: 0 })
    const admin = await createAdminReadOperations({ client: context().client }).getAdminListing(
      'brieflow.ai'
    )
    expect(admin?.retiredCategories).toEqual(['Adult'])
  })

  it('validates a new website like a submission and refuses one that collides', async () => {
    const { context, db, row, submission } = fixture()
    insertPublishedListing(db, {
      categoryIds: [1],
      content: 'Content',
      description: 'Notewise description',
      displayOrder: 1,
      id: 'lst_note',
      isFeatured: false,
      name: 'Notewise',
      publishedAt: '2026-05-16',
      slug: 'notewise.app',
      website: 'https://notewise.app/'
    })
    db.exec(`INSERT INTO listing_media (listing_id, kind, url, sort_order)
      VALUES ('lst_note', 'logo', 'https://assets.example/note.png', 0)`)
    submission('sub_flight', 'inflight.example', 'verified')
    submission('sub_bad', 'casino.example', 'verified')
    await rejectSubmission(context(), {
      category: 'prohibited',
      reason: 'Gambling without a license.',
      submissionId: 'sub_bad'
    })
    const checksum = () =>
      String(row("SELECT checksum FROM listings WHERE id='lst_brief'")?.checksum)
    const moveTo = async (website: string, logoUrl = 'https://assets.example/brief.png') =>
      updateListingDetails(context(), {
        details: {
          categorySlug: 'tools',
          description: 'Brieflow description',
          logoUrl,
          name: 'Brieflow',
          website
        },
        expectedChecksum: checksum(),
        listingId: 'lst_brief'
      })
    // The intake's URL rule: public http(s) only, for the website and the logo.
    for (const website of ['http://127.0.0.1/', 'https://localhost/', 'ftp://brieflow.ai/']) {
      expect(await moveTo(website), website).toMatchObject({
        error: 'invalid_website',
        status: 422
      })
    }
    expect(await moveTo('https://brieflow.ai/', 'http://10.0.0.1/logo.png')).toMatchObject({
      error: 'invalid_logo',
      status: 422
    })
    // Another listing's host or URL, a submission in flight, or a block: refused.
    expect(await moveTo('https://www.notewise.app/pricing')).toMatchObject({
      error: 'website_listed',
      status: 409
    })
    expect(await moveTo('https://inflight.example/')).toMatchObject({
      error: 'website_in_review',
      status: 409
    })
    expect(await moveTo('https://app.casino.example/')).toMatchObject({
      error: 'website_blocked',
      status: 409
    })
    expect(row("SELECT website FROM listings WHERE id='lst_brief'")).toEqual({
      website: 'https://brieflow.ai/'
    })
    // A free host moves.
    expect(await moveTo('https://brieflow.com/')).toEqual({
      fields: ['website'],
      ok: true,
      replayed: false
    })
    expect(row("SELECT slug, website FROM listings WHERE id='lst_brief'")).toEqual({
      slug: 'brieflow.ai',
      website: 'https://brieflow.com/'
    })
  })

  it('refuses a website another listing stores in another spelling, as intake does', async () => {
    const { context, db, row } = fixture()
    // Imported listings mostly have a slug that isn't their host (#64 review probes).
    for (const [id, slug, website] of [
      ['lst_beta', 'beta-tool', 'https://www.new.example/'],
      ['lst_gamma', 'gamma-tool', 'https://gamma.example/']
    ] as const) {
      insertPublishedListing(db, {
        categoryIds: [1],
        content: 'Content',
        description: `${slug} description`,
        displayOrder: 1,
        id,
        isFeatured: false,
        name: slug,
        publishedAt: '2026-05-16',
        slug,
        website
      })
    }
    const moveTo = (id: string, website: string) =>
      updateListingDetails(context(), {
        details: {
          categorySlug: 'tools',
          description: id === 'lst_brief' ? 'Brieflow description' : 'gamma-tool description',
          logoUrl: id === 'lst_brief' ? 'https://assets.example/brief.png' : '',
          name: id === 'lst_brief' ? 'Brieflow' : 'gamma-tool',
          website
        },
        expectedChecksum: String(row('SELECT checksum FROM listings WHERE id=?', id)?.checksum),
        listingId: id
      })
    for (const website of [
      'https://new.example/',
      'https://new.example',
      'http://new.example',
      'https://new.example/?ref=abc',
      'https://new.example/#top'
    ]) {
      expect(await moveTo('lst_brief', website), website).toMatchObject({
        error: 'website_listed',
        status: 409
      })
    }
    // The other direction: another listing stores its website with a query or fragment.
    db.exec("UPDATE listings SET website = 'https://query.example/?ref=abc' WHERE id = 'lst_beta'")
    for (const website of ['https://query.example/', 'https://www.query.example#top']) {
      expect(await moveTo('lst_brief', website), website).toMatchObject({
        error: 'website_listed',
        status: 409
      })
    }
    // Two moves to one website, spelled with and without the trailing slash: the second collides.
    expect(await moveTo('lst_brief', 'https://brieflow.com/')).toMatchObject({ ok: true })
    expect(await moveTo('lst_gamma', 'https://brieflow.com')).toMatchObject({
      error: 'website_listed',
      status: 409
    })
    expect(row("SELECT website FROM listings WHERE id='lst_gamma'")).toEqual({
      website: 'https://gamma.example/'
    })
  })

  it('edits an imported listing with no logo or a site-relative logo; new URLs are checked', async () => {
    const { context, db, row } = fixture()
    // 257 imported listings have no logo (the fallback tile) and 80 a site-relative one.
    for (const [id, slug, logo] of [
      ['lst_bare', 'bare.example', null],
      ['lst_local', 'local.example', '/listing-logos/local.example/logo.png']
    ] as const) {
      insertPublishedListing(db, {
        categoryIds: [1],
        content: 'Content',
        description: `${slug} description`,
        displayOrder: 1,
        id,
        isFeatured: false,
        name: slug,
        publishedAt: '2026-05-16',
        slug,
        website: `https://${slug}/`
      })
      if (logo) {
        db.prepare(
          "INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES (?, 'logo', ?, 0)"
        ).run(id, logo)
      }
    }
    const logos = (id: string) =>
      db.prepare("SELECT url FROM listing_media WHERE listing_id=? AND kind='logo'").all(id)
    const edit = (id: string, slug: string, changes: { logoUrl?: string; name?: string }) =>
      updateListingDetails(context(), {
        // What the details form sends: the stored values, with the logo as '' when there is none.
        details: {
          categorySlug: 'tools',
          description: `${slug} description`,
          logoUrl: id === 'lst_local' ? '/listing-logos/local.example/logo.png' : '',
          name: slug,
          website: `https://${slug}/`,
          ...changes
        },
        expectedChecksum: String(row('SELECT checksum FROM listings WHERE id=?', id)?.checksum),
        listingId: id
      })
    // A name-only edit succeeds and leaves the logo as it was.
    expect(await edit('lst_bare', 'bare.example', { name: 'Bare' })).toEqual({
      fields: ['name'],
      ok: true,
      replayed: false
    })
    expect(logos('lst_bare')).toEqual([])
    expect(await edit('lst_local', 'local.example', { name: 'Local' })).toEqual({
      fields: ['name'],
      ok: true,
      replayed: false
    })
    expect(logos('lst_local')).toEqual([{ url: '/listing-logos/local.example/logo.png' }])
    // A changed logo must be a public URL, as at intake; an emptied one removes the logo.
    for (const logoUrl of ['/listing-logos/other.png', 'http://10.0.0.1/logo.png']) {
      expect(await edit('lst_local', 'local.example', { logoUrl, name: 'Local' })).toMatchObject({
        error: 'invalid_logo',
        status: 422
      })
    }
    // Without a media bucket the new logo is queued for the media cron, never hotlinked (#95).
    expect(
      await edit('lst_bare', 'bare.example', {
        logoUrl: 'https://assets.example/bare.png',
        name: 'Bare'
      })
    ).toEqual({
      fields: ['logo'],
      logo: 'pending',
      notice: expect.stringMatching(/^Saved, but the new logo is queued to be copied\./u),
      ok: true,
      replayed: false
    })
    expect(logos('lst_bare')).toEqual([])
    expect(
      row("SELECT source_url,status FROM media_ingestions WHERE listing_id='lst_bare'")
    ).toEqual({ source_url: 'https://assets.example/bare.png', status: 'pending' })
    expect(await edit('lst_local', 'local.example', { logoUrl: '', name: 'Local' })).toEqual({
      fields: ['logo'],
      ok: true,
      replayed: false
    })
    expect(logos('lst_local')).toEqual([])
  })

  it('hosts a changed logo before the edit, or queues it with the failure the admin sees', async () => {
    const { context, db, row } = fixture()
    const sha256 = 'a'.repeat(64)
    const hosted = {
      bytes: 512,
      contentType: 'image/png',
      height: 256,
      key: `best.serp.co/listings/brieflow.ai/logo/${sha256.slice(0, 16)}.png`,
      sha256,
      sourceUrl: 'https://assets.example/new.png',
      width: 256
    }
    const host = vi.fn(async (input: { sourceUrl: string }) =>
      input.sourceUrl === hosted.sourceUrl
        ? { hosted }
        : input.sourceUrl.endsWith('.svg')
          ? { failure: { code: 'svg', retryable: false } }
          : { failure: { code: 'http_503', retryable: true } }
    )
    const editLogo = (logoUrl: string) =>
      updateListingDetails(context({ media: { host } }), {
        details: {
          categorySlug: String(
            row(
              "SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id='lst_brief' AND lc.is_primary=1"
            )?.slug
          ),
          description: String(
            row("SELECT description FROM listings WHERE id='lst_brief'")?.description
          ),
          logoUrl,
          name: String(row("SELECT name FROM listings WHERE id='lst_brief'")?.name),
          website: String(row("SELECT website FROM listings WHERE id='lst_brief'")?.website)
        },
        expectedChecksum: String(
          row("SELECT checksum FROM listings WHERE id='lst_brief'")?.checksum
        ),
        listingId: 'lst_brief'
      })
    expect(await editLogo('https://assets.example/new.png')).toEqual({
      fields: ['logo'],
      logo: 'hosted',
      ok: true,
      replayed: false
    })
    expect(host).toHaveBeenCalledWith({
      kind: 'logo',
      slug: 'brieflow.ai',
      sourceUrl: 'https://assets.example/new.png'
    })
    expect(
      db
        .prepare(
          "SELECT url,media_key FROM listing_media WHERE listing_id='lst_brief' AND kind='logo'"
        )
        .all()
    ).toEqual([{ media_key: hosted.key, url: hosted.sourceUrl }])
    // A logo that can never be hosted is refused with its reason; nothing is saved (#96 S4).
    const before = row("SELECT checksum FROM listings WHERE id='lst_brief'")?.checksum
    expect(await editLogo('https://assets.example/vector.svg')).toEqual({
      error: 'logo_unhostable',
      message: expect.stringContaining('it is an SVG'),
      ok: false,
      status: 422
    })
    expect(row("SELECT checksum FROM listings WHERE id='lst_brief'")?.checksum).toBe(before)
    expect(
      db
        .prepare(
          "SELECT url,media_key FROM listing_media WHERE listing_id='lst_brief' AND kind='logo'"
        )
        .all()
    ).toEqual([{ media_key: hosted.key, url: hosted.sourceUrl }])
    // A retryable failure saves with a warning, keeps the hosted logo, and queues the new one.
    expect(await editLogo('https://assets.example/busy.png')).toEqual({
      fields: ['logo'],
      logo: 'pending',
      notice: expect.stringContaining('the server answered HTTP 503 (http_503)'),
      ok: true,
      replayed: false
    })
    expect(
      db
        .prepare(
          "SELECT url,media_key FROM listing_media WHERE listing_id='lst_brief' AND kind='logo'"
        )
        .all()
    ).toEqual([{ media_key: hosted.key, url: hosted.sourceUrl }])
    expect(
      row("SELECT source_url,status,last_error FROM media_ingestions WHERE listing_id='lst_brief'")
    ).toEqual({
      last_error: 'http_503',
      source_url: 'https://assets.example/busy.png',
      status: 'pending'
    })
    // Saving the current logo's URL again cancels the queued replacement, fetching nothing
    // (#96 review round 2, S2).
    const hostCalls = host.mock.calls.length
    expect(await editLogo(hosted.sourceUrl)).toEqual({
      fields: ['logo'],
      ok: true,
      replayed: false
    })
    expect(host.mock.calls).toHaveLength(hostCalls)
    expect(
      row("SELECT COUNT(*) AS count FROM media_ingestions WHERE listing_id='lst_brief'")
    ).toEqual({ count: 0 })
    expect(
      db
        .prepare(
          "SELECT url,media_key FROM listing_media WHERE listing_id='lst_brief' AND kind='logo'"
        )
        .all()
    ).toEqual([{ media_key: hosted.key, url: hosted.sourceUrl }])
  })

  it('settles the approved listing’s queued media after the response, once', async () => {
    const { context, row, submission } = fixture()
    submission('sub_quill', 'quillmate.app', 'verified')
    const settle = vi.fn()
    const media = { host: vi.fn(), settle }
    const approve = () =>
      approveSubmission(context({ media }), {
        expectedContentVersion: 1,
        submissionId: 'sub_quill'
      })
    expect(await approve()).toMatchObject({ ok: true, replayed: false })
    const listingId = row(
      "SELECT listing_id FROM listing_submissions WHERE id='sub_quill'"
    )?.listing_id
    expect(settle.mock.calls).toEqual([[listingId]])
    // A replay changes nothing and settles nothing.
    expect(await approve()).toMatchObject({ ok: true, replayed: true })
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('transfers to an account that exists, then removes the owner', async () => {
    const { context, row } = fixture()
    expect(
      await transferListingOwner(context(), {
        email: 'nobody@example.com',
        expectedOwnerUserId: null,
        listingId: 'lst_brief'
      })
    ).toMatchObject({ error: 'no_account', status: 422 })
    expect(
      await transferListingOwner(context(), {
        email: 'Priya@Example.com',
        expectedOwnerUserId: null,
        listingId: 'lst_brief'
      })
    ).toEqual({ ok: true, ownerEmail: 'priya@example.com', replayed: false })
    expect(
      await transferListingOwner(context(), {
        email: 'maya@example.com',
        expectedOwnerUserId: null,
        listingId: 'lst_brief'
      })
    ).toMatchObject({ error: 'conflict', status: 409 })
    expect(
      await removeListingOwner(context(), {
        expectedOwnerUserId: 'user_priya',
        listingId: 'lst_brief'
      })
    ).toEqual({ ok: true, replayed: false })
    expect(row('SELECT COUNT(*) AS owners FROM listing_owners WHERE revoked_at IS NULL')).toEqual({
      owners: 0
    })
  })
})

describe('tag decisions (#341)', () => {
  function tagged() {
    const fixture_ = fixture()
    fixture_.db.exec(`
      INSERT INTO tags (slug, name, category_id, sort_order) VALUES
        ('note-taking', 'Note Taking', 1, 0), ('whiteboards', 'Whiteboards', 2, 0),
        ('retired-tag', 'Retired', 1, 1);
      UPDATE tags SET is_active = 0 WHERE slug = 'retired-tag';
    `)
    const tags = (listingId: string) =>
      (
        fixture_.db
          .prepare(
            `SELECT t.slug FROM listing_tags lt JOIN tags t ON t.id = lt.tag_id
            WHERE lt.listing_id = ? ORDER BY lt.sort_order, t.slug`
          )
          .all(listingId) as Array<{ slug: string }>
      ).map(row => row.slug)
    return { ...fixture_, tags }
  }

  it("sets a listing's tags once, answers a replay, and refuses stale or retired tags", async () => {
    const { context, row, tags } = tagged()
    const set = (next: string[], expectedTags: string[]) =>
      setListingTags(context(), { expectedTags, listingId: 'lst_brief', tags: next })
    expect(await set(['whiteboards', 'note-taking'], [])).toEqual({
      ok: true,
      replayed: false,
      tags: ['whiteboards', 'note-taking']
    })
    expect(tags('lst_brief')).toEqual(['whiteboards', 'note-taking'])
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(row("SELECT checksum FROM listings WHERE id='lst_brief'")).toEqual({
      checksum: 'brief-checksum'
    })
    // The same request again is a replay; one made from a stale view is a conflict.
    expect(await set(['whiteboards', 'note-taking'], [])).toMatchObject({ replayed: true })
    expect(await set(['note-taking'], [])).toMatchObject({ error: 'conflict', status: 409 })
    expect(await set(['retired-tag'], ['whiteboards', 'note-taking'])).toMatchObject({
      error: 'invalid_tags',
      status: 422
    })
    expect(await set(['nope'], ['whiteboards', 'note-taking'])).toMatchObject({ status: 422 })
    expect(tags('lst_brief')).toEqual(['whiteboards', 'note-taking'])
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(
      await setListingTags(context(), { expectedTags: [], listingId: 'nope', tags: [] })
    ).toMatchObject({ status: 404 })
  })

  it('tags a listing while its submission is in review, then the approval still applies', async () => {
    const { context, paidLive, tags } = tagged()
    paidLive('sub_paid')
    expect(
      await setListingTags(context(), {
        expectedTags: [],
        listingId: 'lst_brief',
        tags: ['note-taking']
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(
      await approveSubmission(context(), { expectedContentVersion: 1, submissionId: 'sub_paid' })
    ).toMatchObject({ ok: true, replayed: false })
    // The submission gave no tags, so the admin's stay.
    expect(tags('lst_brief')).toEqual(['note-taking'])
  })

  it('retries once when another publication won the race', async () => {
    const { context, racingClient, tags } = tagged()
    expect(
      await setListingTags(context({ client: racingClient() }), {
        expectedTags: [],
        listingId: 'lst_brief',
        tags: ['whiteboards']
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(tags('lst_brief')).toEqual(['whiteboards'])
  })

  it("approves with the reviewer's tags, which the listing then carries", async () => {
    const { context, db, row, submission, tags } = tagged()
    submission('sub_tags', 'tagged.app', 'verified')
    db.exec(`UPDATE listing_submissions SET tag_slugs = '["note-taking"]' WHERE id = 'sub_tags'`)
    const review = await createAdminReadOperations({
      client: context().client
    }).getSubmissionReview('sub_tags')
    expect(review?.tagSlugs).toEqual(['note-taking'])
    expect(
      await approveSubmission(context(), {
        edits: { tagSlugs: ['retired-tag'] },
        expectedContentVersion: 1,
        submissionId: 'sub_tags'
      })
    ).toMatchObject({ error: 'invalid_tags', status: 422 })
    expect(
      await approveSubmission(context(), {
        edits: { tagSlugs: ['whiteboards', 'note-taking'] },
        expectedContentVersion: 1,
        submissionId: 'sub_tags'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(tags('submission_sub_tags')).toEqual(['whiteboards', 'note-taking'])
    expect(row("SELECT detail FROM listing_submission_events WHERE event_type = 'edited'")).toEqual(
      { detail: JSON.stringify({ fields: ['tags'] }) }
    )
  })

  it('approves an edited submission still naming a retired narrow slug under its hub', async () => {
    const { context, db, row, submission, tags } = tagged()
    db.exec(`
      INSERT INTO categories (slug, name, sort_order) VALUES ('chatbots', 'Chatbots', 2);
      INSERT INTO tags (slug, name, category_id) VALUES ('chatbots', 'Chatbots', 2);
      UPDATE categories SET is_active = 0 WHERE slug = 'chatbots';
    `)
    submission('sub_stale', 'stale.app', 'verified')
    db.exec("UPDATE listing_submissions SET category_slug = 'chatbots' WHERE id = 'sub_stale'")
    expect(
      await approveSubmission(context(), {
        edits: { name: 'Stale, renamed' },
        expectedContentVersion: 1,
        submissionId: 'sub_stale'
      })
    ).toMatchObject({ ok: true, replayed: false })
    expect(
      row(`SELECT c.slug FROM listing_categories lc JOIN categories c ON c.id = lc.category_id
        WHERE lc.listing_id = 'submission_sub_stale' AND lc.is_primary = 1`)
    ).toEqual({ slug: 'apps' })
    expect(tags('submission_sub_stale')).toEqual(['chatbots'])
  })
})

describe('admin allowlist decisions', () => {
  it('adds an admin once and never removes the last one', async () => {
    const { context } = fixture()
    expect(await addAdmin(context(), { email: 'not an email' })).toMatchObject({ status: 422 })
    expect(await addAdmin(context(), { email: 'Alex@serp.co' })).toEqual({
      email: 'alex@serp.co',
      ok: true,
      replayed: false
    })
    expect(await addAdmin(context(), { email: 'alex@serp.co' })).toEqual({
      email: 'alex@serp.co',
      ok: true,
      replayed: true
    })
    expect(await removeAdmin(context(), { email: 'devin@serp.co' })).toEqual({
      email: 'devin@serp.co',
      ok: true,
      replayed: false
    })
    expect(await removeAdmin(context(), { email: 'devin@serp.co' })).toEqual({
      email: 'devin@serp.co',
      ok: true,
      replayed: true
    })
    expect(await removeAdmin(context(), { email: 'alex@serp.co' })).toMatchObject({
      error: 'last_admin',
      status: 409
    })
  })
})
