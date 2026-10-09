import { describe, expect, it } from 'vitest'
import { createAdminReadOperations, toInstant } from './admin-queries'
import { createDatabase } from './client'
import { insertPublishedListing, SqliteD1 } from './test-support'

/**
 * The admin panel's reads (#64) over node:sqlite through the D1 adapter: the queue mixes
 * submissions and revisions per tab, the review DTOs carry what the screens show, and the
 * listing search filters, pages, and counts by the derived admin state.
 */
function fixture(extraSql = '') {
  const d1 = new SqliteD1()
  const db = d1.database
  db.exec(`
    INSERT INTO categories (slug, name, sort_order) VALUES ('tools', 'Tools', 0), ('apps', 'Apps', 1);
    INSERT INTO publication_state (id, version, checksum) VALUES (1, 1, 'before');
    INSERT INTO users (id, name, email, email_verified, created_at)
      VALUES ('user_maya', 'Maya', 'maya@example.com', 1, 1791244800000),
        ('user_jordan', 'Jordan', 'jordan@example.com', 1, 1791244800000);
  `)
  const tools = 1
  for (const [id, slug, name] of [
    ['lst_brief', 'brieflow.ai', 'Brieflow'],
    ['lst_debrief', 'debrief.so', 'Debrief'],
    ['lst_keyb', 'keybazaar.shop', 'KeyBazaar'],
    ['lst_other', 'zeta.example', 'Zeta']
  ] as const) {
    insertPublishedListing(db, {
      categoryIds: [tools],
      content: 'Content',
      description: `${name} description`,
      displayOrder: 0,
      id,
      isFeatured: false,
      name,
      publishedAt: '2026-05-16',
      slug,
      website: `https://${slug}/`
    })
  }
  db.exec(`
    INSERT INTO listing_media (listing_id, kind, url, sort_order)
      VALUES ('lst_brief', 'logo', 'https://assets.example/brief.png', 0);
    INSERT INTO listing_owners (listing_id, user_id, verified_via, verified_at)
      VALUES ('lst_brief', 'user_jordan', 'badge_claim', '2026-09-03T00:00:00.000Z');
    UPDATE listings SET link_rel = 'nofollow', source = 'submission' WHERE id = 'lst_keyb';
    UPDATE listings SET is_active = 0 WHERE id IN ('lst_keyb', 'lst_debrief');
    INSERT INTO listing_events (listing_id, event_type, detail, actor)
      VALUES ('lst_debrief', 'unpublished', '{"note":"Rebrand","reason":"admin"}', 'devin@serp.co');
    INSERT INTO listing_submissions (id, slug, name, description, website, content,
      category_slug, logo_url, status, plan, owner_user_id, badge_verified_at, created_at,
      updated_at, block_key, block_covers_subdomains)
    VALUES
      ('sub_quill', 'quillmate.app', 'Quillmate', 'Writes copy', 'https://quillmate.app/', 'Long',
        'tools', 'https://quillmate.app/logo.png', 'verified', 'free', 'user_maya',
        '2026-10-06T07:00:00.000Z', '2026-10-05 10:00:00', '2026-10-06T07:00:00.000Z',
        'quillmate.app', 1),
      ('sub_old', 'pagecraft.io', 'Pagecraft', 'Sites', 'https://pagecraft.io/', 'Long', 'tools',
        'https://pagecraft.io/logo.png', 'changes_requested', 'free', 'user_maya',
        '2026-10-01T00:00:00.000Z', '2026-10-01 00:00:00', '2026-10-02T00:00:00.000Z',
        'pagecraft.io', 1);
    UPDATE listing_submissions SET reviewer_note = 'Logo is blurry',
      reviewed_at = '2026-10-02T00:00:00.000Z', reviewed_by = 'devin@serp.co' WHERE id = 'sub_old';
    INSERT INTO listing_submissions (id, slug, name, description, website, content,
      category_slug, logo_url, status, plan, paid_at, listing_id, owner_user_id,
      rejection_reason, rejection_category, block_key, block_covers_subdomains)
    VALUES ('sub_keyb', 'keybazaar.shop', 'KeyBazaar', 'Keys', 'https://keybazaar.shop/', 'Long',
      'tools', 'https://keybazaar.shop/logo.png', 'rejected', 'paid', '2026-10-04T12:02:00.000Z',
      'lst_keyb', 'user_maya', 'Unauthorized license keys', 'prohibited', 'keybazaar.shop', 1);
    INSERT INTO listing_submission_url_blocks (url_key, covers_subdomains, submission_id, reason,
      blocked_by, blocked_at)
    VALUES ('keybazaar.shop', 1, 'sub_keyb', 'Unauthorized license keys', 'devin@serp.co',
      '2026-10-05T16:40:00.000Z');
    INSERT INTO listing_submission_resource_links (submission_id, label, url, sort_order)
      VALUES ('sub_quill', 'Docs', 'https://quillmate.app/docs', 0);
    INSERT INTO listing_submission_events (submission_id, event_type, actor)
      VALUES ('sub_quill', 'badge_verified', 'system');
    INSERT INTO listing_revisions (id, listing_id, author_user_id, status, base_checksum, name,
      description, content, category_slug, logo_url, updated_at)
    VALUES ('rev_brief', 'lst_brief', 'user_jordan', 'pending_review', 'stale', 'Brieflow 2',
      'New description', 'New content', 'apps', 'https://assets.example/brief-2.png',
      '2026-10-03T00:00:00.000Z');
    INSERT INTO badge_checks (listing_id, checked_at, outcome, reason, conclusive)
      VALUES ('lst_brief', '2026-10-05T09:00:00.000Z', 'pass', NULL, 1),
        ('lst_brief', '2026-09-21T09:00:00.000Z', 'fail', 'missing', 1);
  `)
  // Zeta's logo waits for the media cron after a failed attempt (#95).
  db.exec(`
    INSERT INTO media_ingestions (listing_id,kind,sort_order,source_url,status,attempts,
      next_attempt_at,last_error)
    VALUES ('lst_other','logo',0,'https://zeta.example/logo.png','pending',1,
      '2026-10-06T12:15:00.000Z','http_503');
  `)
  // Hosted copies the screens render instead of sources (#96 review S9): Brieflow's logo, and
  // Quillmate's submitted logo and social image under the submission's prefix.
  const hosted = (key: string) => `'${key}','${'a'.repeat(64)}','image/png',10,1,1`
  db.exec(`
    DELETE FROM listing_media WHERE listing_id='lst_brief' AND kind='logo';
    INSERT INTO listing_media (listing_id,kind,url,sort_order,media_key,sha256,content_type,bytes,
      width,height)
    VALUES ('lst_brief','logo','https://assets.example/brief.png',0,
      ${hosted(`best.serp.co/listings/brieflow.ai/logo/${'a'.repeat(16)}.png`)});
    INSERT INTO media_ingestions (submission_id,kind,sort_order,source_url,status,attempts,
      media_key,sha256,content_type,bytes,width,height)
    VALUES ('sub_quill','logo',0,'https://quillmate.app/logo.png','hosted',1,
        ${hosted(`best.serp.co/submissions/sub_quill/logo/${'b'.repeat(16)}.png`)}),
      ('sub_quill','image',0,'https://quillmate.app/og.png','hosted',1,
        ${hosted(`best.serp.co/submissions/sub_quill/image/${'c'.repeat(16)}.png`)}),
      ('sub_old','logo',0,'https://pagecraft.io/old-logo.png','hosted',1,
        ${hosted(`best.serp.co/submissions/sub_old/logo/${'d'.repeat(16)}.png`)});
  `)
  if (extraSql)
    db.exec(
      extraSql.replaceAll(
        '$HOSTED',
        hosted(`best.serp.co/revisions/rev_brief/logo/${'e'.repeat(16)}.png`)
      )
    )
  return createAdminReadOperations({ client: createDatabase(d1.asD1Database()) })
}

describe('admin review queue reads', () => {
  it('lists waiting submissions and revisions oldest first, with counts', async () => {
    const reads = fixture()
    const waiting = await reads.listReviewQueue('waiting')
    expect(
      waiting.map(item => [item.kind, item.id, item.status, item.plan, item.badge, item.queuedAt])
    ).toEqual([
      ['revision', 'rev_brief', 'pending_review', 'free', 'pass', '2026-10-03T00:00:00.000Z'],
      ['submission', 'sub_quill', 'verified', 'free', 'pass', '2026-10-06T07:00:00.000Z']
    ])
    expect(waiting[1]).toMatchObject({
      logoUrl: 'https://quillmate.app/logo.png',
      ownerEmail: 'maya@example.com',
      slug: 'quillmate.app'
    })
    expect((await reads.listReviewQueue('changes')).map(item => item.id)).toEqual(['sub_old'])
    expect((await reads.listReviewQueue('all')).map(item => item.id).sort()).toEqual([
      'rev_brief',
      'sub_keyb',
      'sub_old',
      'sub_quill'
    ])
    expect(await reads.reviewQueueCounts()).toEqual({
      changes: 1,
      oldestQueuedAt: '2026-10-03T00:00:00.000Z',
      waiting: 2
    })
  })

  it('reads a submission under review with its submitter, links, events, and duplicates', async () => {
    const reads = fixture()
    const review = await reads.getSubmissionReview('sub_quill')
    expect(review).toMatchObject({
      block: null,
      categoryName: 'Tools',
      contentVersion: 1,
      createdAt: '2026-10-05T10:00:00.000Z',
      duplicateListings: 0,
      duplicateSubmissions: 0,
      kind: 'submission',
      listing: null,
      resourceLinks: [{ label: 'Docs', url: 'https://quillmate.app/docs' }],
      status: 'verified',
      submitter: {
        createdAt: '2026-10-06T00:00:00.000Z',
        email: 'maya@example.com',
        otherSubmissions: 2,
        userId: 'user_maya'
      }
    })
    expect(review?.events.map(event => event.eventType)).toEqual(['badge_verified'])
    const rejected = await reads.getSubmissionReview('sub_keyb')
    expect(rejected).toMatchObject({
      block: {
        blockedBy: 'devin@serp.co',
        reason: 'Unauthorized license keys',
        urlKey: 'keybazaar.shop'
      },
      listing: { id: 'lst_keyb', live: false, slug: 'keybazaar.shop', verifiedOwner: false },
      rejectionCategory: 'prohibited'
    })
    expect(await reads.getSubmissionReview('missing')).toBeNull()
  })

  it('reads a revision with the listing it edits and flags a stale base', async () => {
    const reads = fixture()
    expect(await reads.getRevisionReview('rev_brief')).toMatchObject({
      badgeChecks: [
        { outcome: 'pass', reason: null },
        { outcome: 'fail', reason: 'missing' }
      ],
      categoryName: 'Apps',
      kind: 'revision',
      listing: {
        id: 'lst_brief',
        live: true,
        name: 'Brieflow',
        slug: 'brieflow.ai',
        verifiedOwner: true
      },
      name: 'Brieflow 2',
      stale: true,
      submitter: { email: 'jordan@example.com' }
    })
  })

  it("follows the listing's current owner, not the revision's author (#297 review)", async () => {
    const reads = fixture(`UPDATE listing_owners SET revoked_at = '2026-10-01T00:00:00.000Z',
      revoked_reason = 'transferred' WHERE listing_id = 'lst_brief';`)
    expect(await reads.getRevisionReview('rev_brief')).toMatchObject({
      listing: { verifiedOwner: false }
    })
  })
})

describe('admin listing reads', () => {
  it('searches by name or slug, filters by derived state, and counts facets', async () => {
    const reads = fixture()
    const all = await reads.searchListings(
      { linkRels: [], query: '', sources: [], statuses: [] },
      { limit: 10, offset: 0 }
    )
    expect(all.rows.map(row => [row.slug, row.adminStatus])).toEqual([
      ['brieflow.ai', 'live'],
      ['debrief.so', 'unlisted'],
      ['keybazaar.shop', 'blocked'],
      ['zeta.example', 'live']
    ])
    expect(all).toMatchObject({
      facets: {
        link: { follow: 3, nofollow: 1 },
        source: { admin: 3, submission: 1 },
        status: { blocked: 1, live: 2, unlisted: 1 }
      },
      matches: 4,
      total: 4
    })
    expect(all.rows[0]).toMatchObject({
      logoUrl: 'https://assets.example/brief.png',
      ownerEmail: 'jordan@example.com',
      ownerVerifiedVia: 'badge_claim',
      plan: 'free'
    })
    const brief = await reads.searchListings(
      { linkRels: [], query: 'BRIEF', sources: [], statuses: [] },
      { limit: 10, offset: 0 }
    )
    expect(brief.rows.map(row => row.slug)).toEqual(['brieflow.ai', 'debrief.so'])
    expect(brief).toMatchObject({ matches: 2, total: 4 })
    const unlisted = await reads.searchListings(
      { linkRels: ['follow'], query: 'brief', sources: ['admin'], statuses: ['unlisted'] },
      { limit: 10, offset: 0 }
    )
    expect(unlisted.rows.map(row => row.slug)).toEqual(['debrief.so'])
    const second = await reads.searchListings(
      { linkRels: [], query: '', sources: [], statuses: [] },
      { limit: 2, offset: 2 }
    )
    expect(second.rows.map(row => row.slug)).toEqual(['keybazaar.shop', 'zeta.example'])
  })

  it('reads one listing with its owner, badge checks, activity, and block', async () => {
    const reads = fixture()
    expect(await reads.getAdminListing('brieflow.ai')).toMatchObject({
      adminStatus: 'live',
      badgeChecks: [{ outcome: 'pass' }, { outcome: 'fail' }],
      categoryName: 'Tools',
      categorySlug: 'tools',
      owner: { email: 'jordan@example.com', userId: 'user_jordan', verifiedVia: 'badge_claim' },
      submission: null,
      submissionQueued: false
    })
    expect(await reads.getAdminListing('debrief.so')).toMatchObject({
      activity: [
        {
          actor: 'devin@serp.co',
          detail: '{"note":"Rebrand","reason":"admin"}',
          eventType: 'unpublished',
          source: 'listing'
        }
      ],
      adminStatus: 'unlisted'
    })
    expect(await reads.getAdminListing('keybazaar.shop')).toMatchObject({
      adminStatus: 'blocked',
      block: { urlKey: 'keybazaar.shop' },
      submission: {
        id: 'sub_keyb',
        rejectionCategory: 'prohibited',
        status: 'rejected',
        submitterEmail: 'maya@example.com'
      }
    })
    expect(await reads.getAdminListing('zeta.example')).toMatchObject({
      logoQueue: {
        attempts: 1,
        lastError: 'http_503',
        nextAttemptAt: '2026-10-06T12:15:00.000Z',
        sourceUrl: 'https://zeta.example/logo.png',
        status: 'pending'
      },
      logoUrl: 'https://zeta.example/logo.png'
    })
    expect(await reads.getAdminListing('brieflow.ai')).toMatchObject({
      logoKey: `best.serp.co/listings/brieflow.ai/logo/${'a'.repeat(16)}.png`,
      logoQueue: null
    })
    expect(await reads.getAdminListing('zeta.example')).toMatchObject({
      // The form shows the queued source; the page still shows the current row (none here).
      currentLogoUrl: null,
      logoKey: null,
      logoUrl: 'https://zeta.example/logo.png'
    })
    expect(await reads.getAdminListing('missing.example')).toBeNull()
    expect(await reads.listActiveCategories()).toEqual([
      { name: 'Tools', slug: 'tools' },
      { name: 'Apps', slug: 'apps' }
    ])
  })

  it('normalizes the three time formats D1 rows hold', () => {
    expect(toInstant('2026-10-06 08:12:00')).toBe('2026-10-06T08:12:00.000Z')
    expect(toInstant('2026-10-06T08:12:00.000Z')).toBe('2026-10-06T08:12:00.000Z')
    expect(toInstant(1791244800000)).toBe('2026-10-06T00:00:00.000Z')
    expect(toInstant('2026-05-16')).toBe('2026-05-16T00:00:00.000Z')
    expect(toInstant(null)).toBeNull()
    expect(toInstant('not a time')).toBeNull()
  })
})

describe('hosted copies on the admin screens (#96 review S9)', () => {
  it('names the hosted copy of the current source only, never a stale one', async () => {
    const reads = fixture()
    expect(await reads.getSubmissionReview('sub_quill')).toMatchObject({
      imageKey: `best.serp.co/submissions/sub_quill/image/${'c'.repeat(16)}.png`,
      logoKey: `best.serp.co/submissions/sub_quill/logo/${'b'.repeat(16)}.png`
    })
    // sub_old's hosted logo is of an older source: the screen shows the tile and a link.
    expect(await reads.getSubmissionReview('sub_old')).toMatchObject({
      imageKey: null,
      logoKey: null
    })
    const queue = await reads.listReviewQueue('all')
    expect(Object.fromEntries(queue.map(item => [item.id, item.logoKey]))).toMatchObject({
      rev_brief: null,
      sub_old: null,
      sub_quill: `best.serp.co/submissions/sub_quill/logo/${'b'.repeat(16)}.png`
    })
    // A revision keeps the listing's hosted logo only when it keeps the same source.
    expect(await reads.getRevisionReview('rev_brief')).toMatchObject({ logoKey: null })
  })

  it("shows a revision's own hosted logo of its current source (#96 review round 4, S1)", async () => {
    const slot = (source: string) => `INSERT INTO media_ingestions (revision_id,kind,sort_order,
        source_url,status,attempts,media_key,sha256,content_type,bytes,width,height)
      VALUES ('rev_brief','logo',0,'${source}','hosted',1,$HOSTED)`
    const key = `best.serp.co/revisions/rev_brief/logo/${'e'.repeat(16)}.png`
    const current = fixture(slot('https://assets.example/brief-2.png'))
    expect(await current.getRevisionReview('rev_brief')).toMatchObject({ logoKey: key })
    const queue = await current.listReviewQueue('all')
    expect(queue.find(item => item.id === 'rev_brief')?.logoKey).toBe(key)
    // A copy of an earlier source is never shown for the revision's current logo.
    const stale = fixture(slot('https://assets.example/brief-1.png'))
    expect(await stale.getRevisionReview('rev_brief')).toMatchObject({ logoKey: null })
  })
})
