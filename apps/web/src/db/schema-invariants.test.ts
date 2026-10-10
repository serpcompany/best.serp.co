import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { NOW, planDatabase, seedLiveListing } from './plan-test-support'

/** CHECK constraints, indexes, and triggers of the #62 data model, against the real migrations. */
function database(): DatabaseSync {
  const db = planDatabase()
  seedLiveListing(db, 'lst_a')
  return db
}

function insertSubmission(
  db: DatabaseSync,
  values: Record<string, string | null>,
  slug = 'example.com'
): void {
  // Native intake writes drafts explicitly: owner, clock, block key, and no plan yet.
  const row: Record<string, string | null> = { status: 'draft', ...values }
  if (row.status === 'draft') {
    for (const [column, value] of Object.entries({
      block_covers_subdomains: '1',
      block_key: slug,
      draft_saved_at: NOW,
      owner_user_id: 'user_owner',
      plan: null
    })) {
      if (!(column in row)) row[column] = value
    }
  }
  const columns = Object.keys(row)
  db.prepare(
    `INSERT INTO listing_submissions
      (id,slug,name,description,website,content,category_slug,logo_url${columns.map(c => `,${c}`).join('')})
    VALUES (?,?,'Example','d','https://example.com/','c','tools','https://example.com/l.png'${columns
      .map(() => ',?')
      .join('')})`
  ).run(crypto.randomUUID(), slug, ...Object.values(row))
}

describe('listing columns', () => {
  it('defaults to an admin listing with a followed link and refuses other values', () => {
    const db = database()
    expect(db.prepare('SELECT source, link_rel FROM listings').get()).toEqual({
      link_rel: 'follow',
      source: 'admin'
    })
    expect(() => db.exec("UPDATE listings SET source = 'import'")).toThrow(/listings_source_valid/u)
    expect(() => db.exec("UPDATE listings SET link_rel = 'ugc'")).toThrow(
      /listings_link_rel_valid/u
    )
  })

  it('keeps the primary-category triggers on listings', () => {
    const db = database()
    expect(() => db.exec("DELETE FROM listing_categories WHERE listing_id = 'lst_a'")).toThrow(
      /must retain a primary category/u
    )
  })

  it('never files a published listing under a retired category (#260)', () => {
    const db = database()
    db.exec("INSERT INTO categories (slug, name) VALUES ('adult', 'Adult')")
    const fileUnderAdult = `INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary)
      SELECT 'lst_a', id, 9, 0 FROM categories WHERE slug = 'adult'`
    const retire = "UPDATE categories SET is_active = 0 WHERE slug = 'adult'"
    const unpublish = "UPDATE listings SET is_active = 0 WHERE id = 'lst_a'"
    db.exec(fileUnderAdult)
    // Retiring a category a published listing is filed under is refused.
    expect(() => db.exec(retire)).toThrow(/a category with a published listing cannot retire/u)
    // Unpublished first, it retires; the listing can't be published again while filed under it.
    db.exec(`${unpublish}; ${retire}`)
    expect(() => db.exec("UPDATE listings SET is_active = 1 WHERE id = 'lst_a'")).toThrow(
      /must not be filed under a retired category/u
    )
    // A published listing is never filed under a retired category.
    db.exec(
      "DELETE FROM listing_categories WHERE listing_id = 'lst_a' AND is_primary = 0; UPDATE listings SET is_active = 1 WHERE id = 'lst_a'"
    )
    expect(() => db.exec(fileUnderAdult)).toThrow(/must not be filed under a retired category/u)
  })
})

describe('the #341 taxonomy: tags, best pages, and taxonomy redirects', () => {
  /** `database()` plus an active tag `widgets` (id 1) on the `tools` hub, `lst_a` tagged with it. */
  function taxonomy(): DatabaseSync {
    const db = database()
    db.exec(`
      INSERT INTO tags (slug, name, category_id)
        SELECT 'widgets', 'Widgets', id FROM categories WHERE slug = 'tools';
      INSERT INTO listing_tags (listing_id, tag_id, sort_order) VALUES ('lst_a', 1, 0);
    `)
    return db
  }
  const retireHub = (slug: string) => `UPDATE categories SET is_active = 0 WHERE slug = '${slug}'`

  it('keeps tag slugs unique and is_active a boolean', () => {
    const db = taxonomy()
    expect(() =>
      db.exec("INSERT INTO tags (slug, name, category_id) VALUES ('widgets', 'Again', 1)")
    ).toThrow(/UNIQUE constraint failed: tags.slug/u)
    expect(() => db.exec('UPDATE tags SET is_active = 2')).toThrow(/tags_is_active_boolean/u)
  })

  it('never newly tags a listing with a retired tag, and retiring one keeps its listings', () => {
    const db = taxonomy()
    db.exec(
      "INSERT INTO tags (slug, name, category_id, is_active) VALUES ('gadgets', 'Gadgets', 1, 1)"
    )
    db.exec("UPDATE tags SET is_active = 0 WHERE slug IN ('widgets', 'gadgets')")
    // Retiring a tag touches no membership: public reads filter on the tag's is_active.
    expect(db.prepare('SELECT listing_id, tag_id FROM listing_tags').all()).toEqual([
      { listing_id: 'lst_a', tag_id: 1 }
    ])
    expect(() =>
      db.exec("INSERT INTO listing_tags (listing_id, tag_id) VALUES ('lst_a', 2)")
    ).toThrow(/a listing must not be tagged with a retired tag/u)
    db.exec("UPDATE tags SET is_active = 1 WHERE slug = 'gadgets'")
    db.exec("INSERT INTO listing_tags (listing_id, tag_id) VALUES ('lst_a', 2)")
    // A tag with memberships cannot be deleted; deleting the listing removes them.
    expect(() => db.exec("DELETE FROM tags WHERE slug = 'gadgets'")).toThrow(/FOREIGN KEY/u)
    db.exec(
      "UPDATE listings SET is_active = 0 WHERE id = 'lst_a'; DELETE FROM listings WHERE id = 'lst_a'"
    )
    expect(db.prepare('SELECT COUNT(*) AS count FROM listing_tags').get()).toEqual({ count: 0 })
  })

  it('never files a tag under a retired hub: insert, move, or reactivate', () => {
    const db = taxonomy()
    db.exec(retireHub('apps'))
    const refused = /a tag must not be filed under a retired category/u
    expect(() =>
      db.exec(
        "INSERT INTO tags (slug, name, category_id) SELECT 'g', 'G', id FROM categories WHERE slug = 'apps'"
      )
    ).toThrow(refused)
    expect(() =>
      db.exec(
        "INSERT INTO tags (slug, name, category_id, is_active) SELECT 'g', 'G', id, 0 FROM categories WHERE slug = 'apps'"
      )
    ).toThrow(refused)
    const moveToApps =
      "UPDATE tags SET category_id = (SELECT id FROM categories WHERE slug = 'apps') WHERE slug = 'widgets'"
    expect(() => db.exec(moveToApps)).toThrow(refused)
    // A retired tag may not move to a retired hub either, nor come back while its hub is retired.
    db.exec("UPDATE tags SET is_active = 0 WHERE slug = 'widgets'")
    expect(() => db.exec(moveToApps)).toThrow(refused)
    // `tools` retires once its listing is unpublished and its tag retired.
    db.exec("UPDATE listings SET is_active = 0 WHERE id = 'lst_a'")
    db.exec(retireHub('tools'))
    expect(() => db.exec("UPDATE tags SET is_active = 1 WHERE slug = 'widgets'")).toThrow(refused)
    // Editing a retired tag that stays put under its retired hub is allowed.
    db.exec("UPDATE tags SET name = 'Old widgets', is_active = 0, category_id = category_id")
    expect(db.prepare('SELECT name, is_active FROM tags').get()).toEqual({
      is_active: 0,
      name: 'Old widgets'
    })
  })

  it('moves a tag to another active hub, also bringing a retired one back', () => {
    const db = taxonomy()
    const moveTo = (slug: string, set = '') =>
      `UPDATE tags SET category_id = (SELECT id FROM categories WHERE slug = '${slug}')${set}`
    const hubOf = () =>
      db
        .prepare(
          'SELECT c.slug AS hub, t.is_active FROM tags t JOIN categories c ON c.id = t.category_id'
        )
        .get()
    db.exec(moveTo('apps'))
    expect(hubOf()).toEqual({ hub: 'apps', is_active: 1 })
    // Retired under a retired hub, it comes back moved to an active hub in the same statement.
    db.exec(`UPDATE tags SET is_active = 0; ${retireHub('apps')}`)
    db.exec(moveTo('tools', ', is_active = 1'))
    expect(hubOf()).toEqual({ hub: 'tools', is_active: 1 })
  })

  it('never retires a hub with an active tag, and never deletes a hub with any tag', () => {
    const db = taxonomy()
    // With its listing unpublished, only the active tag holds `tools`.
    db.exec("UPDATE listings SET is_active = 0 WHERE id = 'lst_a'")
    expect(() => db.exec(retireHub('tools'))).toThrow(
      /a category with an active tag cannot retire/u
    )
    db.exec("UPDATE tags SET is_active = 0 WHERE slug = 'widgets'")
    db.exec(retireHub('tools'))
    // `apps` has no listing: only its (retired) tag keeps it from being deleted.
    db.exec(`INSERT INTO tags (slug, name, category_id, is_active)
      SELECT 'gadgets', 'Gadgets', id, 0 FROM categories WHERE slug = 'apps'`)
    expect(() => db.exec("DELETE FROM categories WHERE slug = 'apps'")).toThrow(/FOREIGN KEY/u)
    db.exec("DELETE FROM tags WHERE slug = 'gadgets'")
    db.exec("DELETE FROM categories WHERE slug = 'apps'")
  })

  it('keeps a best page sized 5 to 25, with a pool, a boolean is_active, and an ISO check time', () => {
    const db = taxonomy()
    const page = (slug: string, values: Record<string, number | string | null>) => {
      const row = { tag_id: 1, ...values }
      db.prepare(
        `INSERT INTO best_pages (slug, keyword, title, heading, intro${Object.keys(row)
          .map(column => `, ${column}`)
          .join('')}) VALUES (?, 'widget', 'Best Widgets', 'Best Widgets', 'Intro'${Object.keys(row)
          .map(() => ', ?')
          .join('')})`
      ).run(slug, ...Object.values(row))
    }
    page('default', {})
    expect(db.prepare('SELECT list_size, is_active FROM best_pages').get()).toEqual({
      is_active: 1,
      list_size: 10
    })
    page('smallest', { list_size: 5 })
    page('largest', { list_size: 25 })
    page('hub-only', { category_id: 1, tag_id: null })
    page('intersection', { category_id: 1, keyword_checked_at: NOW, keyword_volume: 4600 })
    for (const size of [4, 26]) {
      expect(() => page(`size-${size}`, { list_size: size })).toThrow(/best_pages_list_size_range/u)
    }
    expect(() => page('no-pool', { tag_id: null })).toThrow(/best_pages_pool/u)
    expect(() => page('flag', { is_active: 2 })).toThrow(/best_pages_is_active_boolean/u)
    for (const value of ['2026-10-06', '2026-10-06 12:00:00', 'yesterday']) {
      expect(() => page(`checked-${value}`, { keyword_checked_at: value }), value).toThrow(
        /best_pages_keyword_checked_at_iso/u
      )
    }
    expect(() => page('default', {})).toThrow(/UNIQUE constraint failed: best_pages.slug/u)
  })

  it('keeps a best page entry either a pin at a unique position or an exclusion', () => {
    const db = taxonomy()
    seedLiveListing(db, 'lst_b')
    seedLiveListing(db, 'lst_c')
    db.exec(`INSERT INTO best_pages (slug, keyword, title, heading, intro, tag_id)
      VALUES ('widget', 'widget', 'Best Widgets', 'Best Widgets', 'Intro', 1)`)
    const entry = (
      listing: string,
      position: number | null,
      excluded: number,
      blurb: string | null
    ) =>
      db
        .prepare(
          'INSERT INTO best_page_listings (best_page_id, listing_id, position, excluded, blurb) VALUES (1, ?, ?, ?, ?)'
        )
        .run(listing, position, excluded, blurb)
    const refused = /best_page_listings_pin_or_exclusion/u
    expect(() => entry('lst_a', null, 0, null)).toThrow(refused)
    expect(() => entry('lst_a', 0, 0, null)).toThrow(refused)
    expect(() => entry('lst_a', 1, 1, null)).toThrow(refused)
    expect(() => entry('lst_a', null, 1, 'Why')).toThrow(refused)
    expect(() => entry('lst_a', 1, 2, null)).toThrow(/best_page_listings_excluded_boolean/u)
    entry('lst_a', 1, 0, 'The pick for most teams.')
    expect(() => entry('lst_b', 1, 0, null)).toThrow(
      /UNIQUE constraint failed: best_page_listings.best_page_id, best_page_listings.position/u
    )
    entry('lst_b', 2, 0, null)
    entry('lst_c', null, 1, null)
    // Deleting the page or a listing removes its entries.
    db.exec(
      "UPDATE listings SET is_active = 0 WHERE id = 'lst_c'; DELETE FROM listings WHERE id = 'lst_c'"
    )
    expect(db.prepare('SELECT COUNT(*) AS count FROM best_page_listings').get()).toEqual({
      count: 2
    })
    db.exec('DELETE FROM best_pages')
    expect(db.prepare('SELECT COUNT(*) AS count FROM best_page_listings').get()).toEqual({
      count: 0
    })
  })

  it('points a taxonomy redirect at exactly the target its kind names', () => {
    const db = taxonomy()
    db.exec(`INSERT INTO best_pages (slug, keyword, title, heading, intro, tag_id)
      VALUES ('widget', 'widget', 'Best Widgets', 'Best Widgets', 'Intro', 1)`)
    const redirect = (
      source: [string, string],
      target: string,
      ids: { best?: number; category?: number; tag?: number } = {}
    ) =>
      db
        .prepare(
          `INSERT INTO taxonomy_redirects (source_kind, source_slug, target_kind,
            target_category_id, target_tag_id, target_best_page_id, manifest_id)
          VALUES (?, ?, ?, ?, ?, ?, 'manifest')`
        )
        .run(...source, target, ids.category ?? null, ids.tag ?? null, ids.best ?? null)
    redirect(['category', 'old-hub'], 'category', { category: 1 })
    redirect(['category', 'old-widgets'], 'tag', { tag: 1 })
    redirect(['tag', 'renamed-widgets'], 'best', { best: 1 })
    redirect(['best', 'old-widget'], 'best', { best: 1 })
    redirect(['category', 'other'], 'directory')
    const mismatched = /taxonomy_redirects_target_matches_kind/u
    for (const [target, ids] of [
      ['category', {}],
      ['category', { category: 1, tag: 1 }],
      ['tag', { category: 1 }],
      ['best', { best: 1, tag: 1 }],
      ['directory', { category: 1 }]
    ] as const) {
      expect(() => redirect(['category', `bad-${target}`], target, ids), target).toThrow(mismatched)
    }
    expect(() => redirect(['listing', 'x'], 'directory')).toThrow(
      /taxonomy_redirects_source_kind_valid/u
    )
    expect(() => redirect(['category', 'x'], 'home')).toThrow(
      /taxonomy_redirects_target_kind_valid/u
    )
    // One redirect per old URL; the same slug may redirect from another kind.
    expect(() => redirect(['category', 'old-widgets'], 'directory')).toThrow(
      /UNIQUE constraint failed: taxonomy_redirects.source_kind, taxonomy_redirects.source_slug/u
    )
    redirect(['tag', 'old-widgets'], 'directory')
    // A redirect's target cannot be deleted from under it.
    expect(() => db.exec('DELETE FROM best_pages')).toThrow(/FOREIGN KEY/u)
  })

  it("keeps a Creator's suggested tags a JSON array of at most three, or not given", () => {
    const db = database()
    db.exec(`INSERT INTO listing_revisions (id, listing_id, author_user_id, base_checksum, name,
      description, category_slug, logo_url)
      VALUES ('rev', 'lst_a', 'user_owner', 'c', 'n', 'd', 'tools', 'https://example.com/l.png')`)
    insertSubmission(db, {})
    for (const table of ['listing_submissions', 'listing_revisions']) {
      const set = (value: string | null) =>
        db.prepare(`UPDATE ${table} SET tag_slugs = ?`).run(value)
      for (const value of [null, '[]', '["widgets"]', '["a","b","c"]']) set(value)
      for (const value of [
        '',
        'widgets',
        '["a"',
        '"widgets"',
        '{"tags":[]}',
        '["a","b","c","d"]'
      ]) {
        expect(() => set(value), `${table} ${value}`).toThrow(
          new RegExp(`${table}_tag_slugs_valid`, 'u')
        )
      }
    }
  })
})

describe('submission status, plan, and decision invariants', () => {
  it('keeps a pre-#62 insert valid: it defaults to the legacy free flow, never a draft', () => {
    const db = database()
    // The columns the Worker deployed before #62 wrote, less the since-dropped token digest.
    db.prepare(
      `INSERT INTO listing_submissions (category_slug,content,description,id,
        logo_url,name,slug,video_url,website)
      VALUES ('tools','c','d',?,'https://example.com/l.png','Example','example.com',NULL,
        'https://example.com/')`
    ).run(crypto.randomUUID())
    expect(
      db.prepare('SELECT status, plan, block_key, owner_user_id FROM listing_submissions').get()
    ).toEqual({ block_key: null, owner_user_id: null, plan: 'free', status: 'pending_badge' })
  })

  it('requires a draft to be native (owner, block key) and every later status to have a plan', () => {
    const db = database()
    insertSubmission(db, {})
    expect(db.prepare('SELECT status, plan FROM listing_submissions').get()).toEqual({
      plan: null,
      status: 'draft'
    })
    for (const [values, constraint] of [
      [{ owner_user_id: null }, 'listing_submissions_draft_native'],
      [{ block_key: null }, 'listing_submissions_draft_native'],
      [{ plan: 'free' }, 'listing_submissions_draft_plan']
    ] as const) {
      expect(() => insertSubmission(db, values, 'a.example'), constraint).toThrow(
        new RegExp(constraint, 'u')
      )
    }
    expect(() => insertSubmission(db, { plan: null, status: 'verified' }, 'b.example')).toThrow(
      /listing_submissions_plan_chosen/u
    )
    expect(() =>
      insertSubmission(db, { plan: 'paid', status: 'pending_badge' }, 'c.example')
    ).toThrow(/listing_submissions_pending_badge_free/u)
    expect(() =>
      insertSubmission(db, { paid_at: NOW, plan: 'paid', status: 'draft' }, 'd.example')
    ).toThrow(/listing_submissions_draft_unpaid/u)
  })

  it('keeps a draft clock in ISO form, a bounded reminder count, and a withdrawal reason', () => {
    const db = database()
    expect(() => insertSubmission(db, { draft_saved_at: null })).toThrow(
      /listing_submissions_draft_clock/u
    )
    // Not toISOString() output: other formats, an impossible date, and unparseable text.
    for (const value of [
      '2026-10-06 12:00:00',
      '2026-10-06T12:00:00Z',
      '2026-13-06T12:00:00.000Z',
      'yesterday'
    ]) {
      expect(() => insertSubmission(db, { draft_saved_at: value }), value).toThrow(
        /listing_submissions_draft_saved_at_iso/u
      )
    }
    expect(() =>
      insertSubmission(db, { draft_last_reminder_at: NOW, draft_reminders_sent: '6' })
    ).toThrow(/listing_submissions_draft_reminders_range/u)
    expect(() => insertSubmission(db, { draft_reminders_sent: '1' })).toThrow(
      /listing_submissions_draft_reminder_recorded/u
    )
    expect(() => insertSubmission(db, { status: 'withdrawn' })).toThrow(
      /listing_submissions_withdrawal_reason_when_withdrawn/u
    )
    expect(() =>
      insertSubmission(db, { plan: 'free', status: 'pending_badge', withdrawal_reason: 'owner' })
    ).toThrow(/listing_submissions_withdrawal_reason_when_withdrawn/u)
    expect(() => insertSubmission(db, { status: 'withdrawn', withdrawal_reason: 'spam' })).toThrow(
      /listing_submissions_withdrawal_reason_valid/u
    )
    insertSubmission(db, { status: 'withdrawn', withdrawal_reason: 'expired' })
  })

  it('keeps an exact-host block key equal to the slug, and the scope set with the key', () => {
    const db = database()
    expect(() =>
      insertSubmission(
        db,
        {
          block_covers_subdomains: '0',
          block_key: 'example.com',
          plan: 'free',
          status: 'pending_badge'
        },
        'go.example.com'
      )
    ).toThrow(/listing_submissions_block_scope/u)
    expect(() =>
      insertSubmission(
        db,
        {
          block_covers_subdomains: null,
          block_key: 'example.com',
          plan: 'free',
          status: 'pending_badge'
        },
        'example.com'
      )
    ).toThrow(/listing_submissions_block_scope/u)
    insertSubmission(
      db,
      {
        block_covers_subdomains: '0',
        block_key: 'github.io',
        plan: 'free',
        status: 'pending_badge'
      },
      'github.io'
    )
  })

  it('keeps the block key on the slug or a parent domain of it', () => {
    const db = database()
    insertSubmission(
      db,
      {
        block_covers_subdomains: '1',
        block_key: 'example.com',
        plan: 'free',
        status: 'pending_badge'
      },
      'go.example.com'
    )
    for (const [slug, blockKey] of [
      ['other.example', 'example.com'],
      ['notexample.com', 'example.com']
    ] as const) {
      expect(() =>
        insertSubmission(
          db,
          {
            block_covers_subdomains: '1',
            block_key: blockKey,
            plan: 'free',
            status: 'pending_badge'
          },
          slug
        )
      ).toThrow(/listing_submissions_block_key_matches/u)
    }
  })

  it('never withdraws a paid submission unless its payment was refunded', () => {
    const db = database()
    expect(() =>
      insertSubmission(db, {
        paid_at: NOW,
        plan: 'paid',
        status: 'withdrawn',
        withdrawal_reason: 'owner'
      })
    ).toThrow(/listing_submissions_withdrawn_unpaid/u)
    insertSubmission(db, {
      paid_at: NOW,
      plan: 'paid',
      refunded_at: NOW,
      status: 'withdrawn',
      withdrawal_reason: 'owner'
    })
  })

  it('ties payment and refund timestamps to the plan', () => {
    const db = database()
    expect(() =>
      insertSubmission(db, { paid_at: NOW, plan: 'free', status: 'pending_badge' })
    ).toThrow(/listing_submissions_payment_matches_plan/u)
    expect(() =>
      insertSubmission(db, { plan: 'paid', refunded_at: NOW, status: 'verified' })
    ).toThrow(/listing_submissions_/u)
    expect(() => insertSubmission(db, { plan: 'paid', status: 'verified' })).toThrow(
      /listing_submissions_verified_qualified/u
    )
    expect(() =>
      insertSubmission(db, { paid_at: NOW, plan: 'paid', status: 'paid_pending_review' })
    ).toThrow(/listing_submissions_live_review_paid/u)
    // Refunded and kept as a free listing.
    insertSubmission(db, {
      listing_id: 'lst_a',
      paid_at: NOW,
      plan: 'free',
      refunded_at: NOW,
      status: 'approved'
    })
  })

  it('records a rejection reason and category together, only on rejected rows', () => {
    const db = database()
    expect(() =>
      insertSubmission(db, { plan: 'free', rejection_reason: 'Spam', status: 'rejected' })
    ).toThrow(/listing_submissions_rejection_complete/u)
    expect(() =>
      insertSubmission(db, {
        plan: 'free',
        rejection_category: 'other',
        rejection_reason: 'Spam',
        status: 'verified'
      })
    ).toThrow(/listing_submissions_rejection_when_rejected/u)
    expect(() =>
      insertSubmission(db, {
        plan: 'free',
        rejection_category: 'terms',
        rejection_reason: 'Spam',
        status: 'rejected'
      })
    ).toThrow(/listing_submissions_rejection_category_valid/u)
  })

  it('keeps one active submission per URL key, drafts included, and frees it on a decision', () => {
    const db = database()
    insertSubmission(db, {})
    expect(() => insertSubmission(db, { plan: 'free', status: 'pending_badge' })).toThrow(
      /UNIQUE constraint failed: listing_submissions.slug/u
    )
    db.exec("UPDATE listing_submissions SET status = 'withdrawn', withdrawal_reason = 'admin'")
    insertSubmission(db, { plan: 'free', status: 'pending_badge' })
  })

  it('refuses to delete a user who owns submissions, listings, or revisions', () => {
    const db = database()
    insertSubmission(db, { owner_user_id: 'user_owner' })
    expect(() => db.exec("DELETE FROM users WHERE id = 'user_owner'")).toThrow(/FOREIGN KEY/u)
    db.prepare(
      `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
      VALUES ('lst_a','user_other','paid_claim',?)`
    ).run(NOW)
    expect(() => db.exec("DELETE FROM users WHERE id = 'user_other'")).toThrow(/FOREIGN KEY/u)
  })
})

describe('ownership, URL blocks, and badge checks', () => {
  it('allows one current owner per listing and keeps revoked owners as history', () => {
    const db = database()
    const grant = (user: string) =>
      db
        .prepare(
          `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
          VALUES ('lst_a',?,'badge_claim',?)`
        )
        .run(user, NOW)
    grant('user_owner')
    expect(() => grant('user_other')).toThrow(/UNIQUE constraint failed/u)
    expect(() => db.exec("UPDATE listing_owners SET revoked_at = 'now'")).toThrow(
      /listing_owners_revocation_complete/u
    )
    db.exec("UPDATE listing_owners SET revoked_at = 'now', revoked_reason = 'badge_removed'")
    grant('user_other')
    expect(() =>
      db
        .prepare(
          `INSERT INTO listing_owners (listing_id,user_id,verified_via,verified_at)
          VALUES ('lst_a','user_owner','email',?)`
        )
        .run(NOW)
    ).toThrow(/listing_owners_verified_via_valid/u)
  })

  it('blocks a URL key once at a time and refuses new submissions while blocked', () => {
    const db = database()
    const block = () =>
      db.exec(`INSERT INTO listing_submission_url_blocks
        (url_key,covers_subdomains,reason,blocked_by,blocked_at)
        VALUES ('example.com',1,'Malware','admin','${NOW}')`)
    block()
    expect(block).toThrow(/UNIQUE constraint failed/u)
    expect(() => insertSubmission(db, {})).toThrow(/blocked until an admin lifts the block/u)
    expect(() => db.exec("UPDATE listing_submission_url_blocks SET lifted_at = 'now'")).toThrow(
      /listing_submission_url_blocks_lift_complete/u
    )
    db.exec("UPDATE listing_submission_url_blocks SET lifted_at = 'now', lifted_by = 'admin'")
    insertSubmission(db, {})
    block()
  })

  it('records badge checks where only a conclusive miss counts and a pass needs no reason', () => {
    const db = database()
    const check = (outcome: string, reason: string | null, conclusive: number) =>
      db
        .prepare(
          'INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive) VALUES (?,?,?,?,?)'
        )
        .run('lst_a', NOW, outcome, reason, conclusive)
    check('pass', null, 1)
    check('fail', 'badge_missing', 1)
    check('fail', 'timeout', 0)
    expect(() => check('pass', null, 0)).toThrow(/badge_checks_pass_conclusive/u)
    expect(() => check('fail', null, 1)).toThrow(/badge_checks_fail_reason/u)
    expect(() => check('error', 'timeout', 0)).toThrow(/badge_checks_outcome_valid/u)
    expect(() =>
      db
        .prepare(
          'INSERT INTO badge_checks (listing_id,checked_at,outcome,reason,conclusive) VALUES (?,?,?,?,?)'
        )
        .run('lst_a', '2026-10-06 12:00:00', 'pass', null, 1)
    ).toThrow(/badge_checks_checked_at_iso/u)
    // Badge history sits outside the catalog: the publication state never moves.
    expect(db.prepare('SELECT version FROM publication_state').get()).toEqual({ version: 1 })
  })
})
