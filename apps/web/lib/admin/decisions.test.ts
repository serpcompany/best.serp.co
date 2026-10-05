/**
 * Every admin decision (#64) on node:sqlite with the checked-in migrations: approvals publish
 * and email once, replays are no-ops, stale views answer 409, rejections block or refuse as the
 * category requires, listing actions log, and the allowlist never loses its last admin.
 */
import { createDatabase } from '@serpdirectory/data-ops/client'
import { insertPublishedListing, SqliteD1 } from '@serpdirectory/data-ops/test-support'
import { describe, expect, it, vi } from 'vitest'
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
  return { context, db, emails, paidLive, row, submission }
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
    // A replay (double click, retry) changes nothing and sends nothing.
    expect(await approve()).toEqual({ listingSlug: 'quillmate.app', ok: true, replayed: true })
    expect(row('SELECT version FROM publication_state')).toEqual({ version: 2 })
    expect(emails).toHaveLength(1)
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
    expect(await send()).toEqual({ ok: true, replayed: true })
    expect(
      row("SELECT status, reviewer_note FROM listing_submissions WHERE id='sub_quill'")
    ).toEqual({ reviewer_note: 'Logo is blurry.', status: 'changes_requested' })
    expect(emails).toEqual([
      {
        eventKey: 'submission-changes-requested:sub_quill:1',
        input: {
          note: 'Logo is blurry.',
          submissionId: 'sub_quill',
          submissionName: 'Name sub_quill'
        },
        template: 'changes-requested',
        to: 'maya@example.com'
      }
    ])
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
    ).toEqual({ ok: true, refunded: false, replayed: false })
    expect(
      await rejectSubmission(context(), {
        category: 'prohibited',
        reason: 'Gambling without a license.',
        submissionId: 'sub_bad'
      })
    ).toEqual({ ok: true, refunded: false, replayed: false })
    expect(
      await rejectSubmission(context(), {
        category: 'prohibited',
        reason: 'Again.',
        submissionId: 'sub_bad'
      })
    ).toEqual({ ok: true, refunded: false, replayed: true })
    expect(
      row('SELECT url_key FROM listing_submission_url_blocks WHERE lifted_at IS NULL')
    ).toEqual({ url_key: 'casino.example' })
    expect(emails.map(email => [email.template, email.eventKey])).toEqual([
      ['submission-rejected', 'submission-rejected:sub_other'],
      ['submission-rejected-prohibited', 'submission-rejected:sub_bad']
    ])
    // "Allow resubmission" lifts the block once; a second click is a no-op.
    expect(await allowResubmission(context(), { urlKey: 'casino.example' })).toEqual({
      ok: true,
      replayed: false
    })
    expect(await allowResubmission(context(), { urlKey: 'casino.example' })).toEqual({
      ok: true,
      replayed: true
    })
    expect(row('SELECT lifted_by FROM listing_submission_url_blocks')).toEqual({
      lifted_by: 'devin@serp.co'
    })
  })

  it('unpublishes a live paid submission on rejection, and refuses a refund it cannot make', async () => {
    const { context, paidLive, row } = fixture()
    paidLive('sub_paid')
    expect(
      await rejectSubmission(context(), {
        category: 'other',
        reason: 'Duplicate of another listing.',
        submissionId: 'sub_paid'
      })
    ).toMatchObject({ error: 'refund_unavailable', status: 409 })
    expect(row("SELECT is_active FROM listings WHERE id='lst_brief'")).toEqual({ is_active: 1 })
    const refundRejectedSubmission = vi.fn(async () => {})
    expect(
      await rejectSubmission(context({ refunds: { refundRejectedSubmission } }), {
        category: 'other',
        reason: 'Duplicate of another listing.',
        submissionId: 'sub_paid'
      })
    ).toEqual({ ok: true, refunded: true, replayed: false })
    expect(refundRejectedSubmission).toHaveBeenCalledWith({
      actor: 'devin@serp.co',
      submissionId: 'sub_paid'
    })
    expect(row("SELECT is_active FROM listings WHERE id='lst_brief'")).toEqual({ is_active: 0 })
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

describe('admin allowlist decisions', () => {
  it('adds an admin once and never removes the last one', async () => {
    const { context } = fixture()
    expect(await addAdmin(context(), { email: 'not an email' })).toMatchObject({ status: 422 })
    expect(await addAdmin(context(), { email: 'Alex@serp.co' })).toEqual({
      email: 'alex@serp.co',
      ok: true,
      replayed: false
    })
    expect(await addAdmin(context(), { email: 'alex@serp.co' })).toMatchObject({
      error: 'already_admin',
      message: 'alex@serp.co is already an admin.',
      status: 409
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
