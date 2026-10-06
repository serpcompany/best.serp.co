import { beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from './client'
import { createSubmissionOperations, type SubmissionInput } from './submissions'
import { insertPublishedListing, SqliteD1 } from './test-support'

const input: SubmissionInput = {
  category: 'tools',
  content: 'Long form submitted content.',
  description: 'A sufficiently descriptive submission.',
  faqs: [
    { question: 'First?', answer: 'First answer.' },
    { question: 'Second?', answer: 'Second answer.' }
  ],
  logoUrl: 'https://assets.example.com/logo.png',
  name: 'Example',
  resourceLinks: [
    { label: 'Docs', url: 'https://example.com/docs' },
    { label: 'Support', url: 'https://example.com/support' }
  ],
  videoUrl: 'https://assets.example.com/video.mp4',
  website: 'https://example.com/'
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

describe('shared submission data operations', () => {
  let sqlite: SqliteD1

  beforeEach(() => {
    sqlite = new SqliteD1()
    sqlite.database
      .prepare(
        `INSERT INTO categories(slug,name,description,sort_order,is_active)
        VALUES ('tools','Tools','Tools',0,1)`
      )
      .run()
    sqlite.database
      .prepare(
        `INSERT INTO publication_state(id,version,checksum,published_at)
        VALUES (1,1,'before','2026-01-01T00:00:00.000Z')`
      )
      .run()
  })

  function operations() {
    return createSubmissionOperations({
      client: createDatabase(sqlite.asD1Database()),
      clock: () => new Date('2026-08-01T00:00:00.000Z')
    })
  }

  it('creates normalized submissions atomically and stores only hashes', async () => {
    const saved = await operations().createSubmission(input)

    expect(saved.slug).toBe('example.com')
    const rows = sqlite.database
      .prepare('SELECT access_token_hash FROM listing_submissions')
      .all() as Array<{ access_token_hash: string }>
    expect(rows).toEqual([{ access_token_hash: await hash(saved.token) }])
    expect(JSON.stringify(rows)).not.toContain(saved.token)
    await expect(operations().createSubmission(input)).rejects.toMatchObject({
      code: 'duplicate_submission',
      status: 409
    })
    expect(
      sqlite.database
        .prepare(
          `SELECT label,sort_order FROM listing_submission_resource_links
          WHERE submission_id=? ORDER BY sort_order`
        )
        .all(saved.id)
    ).toEqual([
      { label: 'Docs', sort_order: 0 },
      { label: 'Support', sort_order: 1 }
    ])
    expect(
      sqlite.database
        .prepare(
          `SELECT question,sort_order FROM listing_submission_faqs
          WHERE submission_id=? ORDER BY sort_order`
        )
        .all(saved.id)
    ).toEqual([
      { question: 'First?', sort_order: 0 },
      { question: 'Second?', sort_order: 1 }
    ])
  })

  it('preserves public URL validation and capability access', async () => {
    await expect(
      operations().createSubmission({
        ...input,
        website: 'http://127.0.0.1/private'
      })
    ).rejects.toMatchObject({ code: 'invalid_url' })

    const saved = await operations().createSubmission(input)
    await expect(operations().getSubmission(saved.id, saved.token)).resolves.toMatchObject({
      id: saved.id,
      slug: 'example.com',
      status: 'pending_badge'
    })
    await expect(operations().getSubmission(saved.id, 'wrong-capability')).rejects.toMatchObject({
      code: 'not_found',
      status: 404
    })
  })

  it('refuses a website whose slug would end in a file extension', async () => {
    for (const website of [
      'https://chart.js/',
      'https://www.p5.JS/',
      'https://feed.example.xml/'
    ]) {
      await expect(
        operations().createSubmission({ ...input, website }),
        website
      ).rejects.toMatchObject({
        code: 'invalid_url',
        status: 400
      })
    }
    expect(
      sqlite.database.prepare('SELECT COUNT(*) AS count FROM listing_submissions').get()
    ).toEqual({ count: 0 })
    // Domain-name slugs whose TLD is not a file extension stay valid pages.
    await expect(
      operations().createSubmission({ ...input, website: 'https://autoenhance.ai/' })
    ).resolves.toMatchObject({ slug: 'autoenhance.ai' })
  })

  // #77: the batch size follows the input, so data-ops caps it like the form does.
  it('refuses more than five resource links or FAQs before touching D1', async () => {
    const link = { label: 'Docs', url: 'https://example.com/docs' }
    const faq = { answer: 'Yes.', question: 'Free?' }
    for (const overflow of [{ resourceLinks: Array(6).fill(link) }, { faqs: Array(6).fill(faq) }]) {
      await expect(
        operations().createSubmission({ ...input, ...overflow, website: 'https://capped.example/' })
      ).rejects.toMatchObject({ code: 'too_many_items', status: 400 })
    }
    await expect(
      operations().createSubmission({
        ...input,
        faqs: Array(5).fill(faq),
        resourceLinks: Array(5).fill(link),
        website: 'https://capped.example/'
      })
    ).resolves.toMatchObject({ slug: 'capped.example' })
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
      'https://bücher.de/'
    ]) {
      await expect(
        operations().createSubmission({ ...input, website }),
        website
      ).rejects.toMatchObject({ code: 'url_blocked', status: 403 })
    }
    expect(
      sqlite.database.prepare('SELECT COUNT(*) AS count FROM listing_submissions').get()
    ).toEqual({ count: 0 })
    await expect(
      operations().createSubmission({ ...input, website: 'https://github.io/' })
    ).rejects.toMatchObject({ code: 'url_blocked' })
    // An exact-host block on a public suffix never covers the separate sites under it.
    for (const website of ['https://notcasino.com/', 'https://unrelated-user.github.io/']) {
      await expect(
        operations().createSubmission({ ...input, website }),
        website
      ).resolves.toMatchObject({ slug: new URL(website).hostname })
    }
  })

  it('normalizes the slug and block key, so host variants count as duplicates', async () => {
    const saved = await operations().createSubmission({
      ...input,
      website: 'https://www.Example.COM./'
    })
    expect(saved.slug).toBe('example.com')
    expect(
      sqlite.database.prepare('SELECT slug, block_key FROM listing_submissions').get()
    ).toEqual({ block_key: 'example.com', slug: 'example.com' })
    await expect(
      operations().createSubmission({ ...input, website: 'https://example.com%2E/' })
    ).rejects.toMatchObject({ code: 'duplicate_submission' })

    const sub = await operations().createSubmission({
      ...input,
      website: 'https://go.example.com/'
    })
    expect(sub.slug).toBe('go.example.com')
    expect(
      sqlite.database
        .prepare('SELECT block_key FROM listing_submissions WHERE slug=?')
        .get('go.example.com')
    ).toEqual({ block_key: 'example.com' })
  })

  it('refuses a website another listing stores in another spelling (#64 review)', async () => {
    // Imported listings mostly have a slug that isn't their host.
    insertPublishedListing(sqlite.database, {
      categoryIds: [
        (
          sqlite.database.prepare("SELECT id FROM categories WHERE slug='tools'").get() as {
            id: number
          }
        ).id
      ],
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
    for (const website of [
      'https://new.example/',
      'http://new.example',
      'https://www.new.example/',
      'https://new.example/?ref=producthunt',
      'https://new.example/#top'
    ]) {
      await expect(
        operations().createSubmission({ ...input, website }),
        website
      ).rejects.toMatchObject({ code: 'listing_exists', status: 409 })
    }
    // The other direction: a stored website with a query or fragment.
    sqlite.database
      .prepare("UPDATE listings SET website='https://new.example/?ref=abc#top' WHERE id='lst_beta'")
      .run()
    for (const website of ['https://new.example/', 'https://www.new.example#pricing']) {
      await expect(
        operations().createSubmission({ ...input, website }),
        website
      ).rejects.toMatchObject({ code: 'listing_exists', status: 409 })
    }
    // Another page on that host isn't matched: comparing stored websites by host is #94.
    await expect(
      operations().createSubmission({ ...input, website: 'https://new.example/other' })
    ).resolves.toMatchObject({ slug: 'new.example' })
  })

  it('rolls back one of two concurrent verification transitions from the same snapshot', async () => {
    const saved = await operations().createSubmission(input)
    const attempts = await Promise.allSettled([
      operations().finishVerification(saved.id, saved.token, {
        code: 'badge_missing',
        ok: false
      }),
      operations().finishVerification(saved.id, saved.token, {
        code: 'wrong_destination',
        ok: false
      })
    ])

    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(1)
    expect(
      sqlite.database
        .prepare('SELECT verification_attempts FROM listing_submissions WHERE id=?')
        .get(saved.id)
    ).toEqual({ verification_attempts: 1 })
    expect(
      sqlite.database
        .prepare(
          `SELECT COUNT(*) AS count FROM listing_submission_events
          WHERE submission_id=? AND event_type='verification_failed'`
        )
        .get(saved.id)
    ).toEqual({ count: 1 })
  })

  it('keeps transient failures out of the attempt count and enforces the rate limit', async () => {
    const saved = await operations().createSubmission(input)
    const state = await operations().finishVerification(saved.id, saved.token, {
      code: 'site_unreachable',
      ok: false
    })
    expect(sqlite.statements.some(statement => /\bTEMP\b/iu.test(statement.sql))).toBe(false)
    expect(state.verificationAttempts).toBe(0)
    expect(state.lastVerificationError).toBe('site_unreachable')

    for (let request = 0; request < 10; request += 1) {
      await operations().consumeRateLimit('203.0.113.10')
    }
    await expect(operations().consumeRateLimit('203.0.113.10')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429
    })
    await expect(operations().consumeRateLimit('203.0.113.11')).resolves.toBeUndefined()
    expect(
      sqlite.database
        .prepare(
          'SELECT fingerprint_hash,request_count FROM listing_submission_rate_limits ORDER BY request_count'
        )
        .all()
    ).toEqual([
      { fingerprint_hash: await hash('203.0.113.11'), request_count: 1 },
      { fingerprint_hash: await hash('203.0.113.10'), request_count: 11 }
    ])
  })

  it('gates private previews by digest and verified status and revokes them after decision', async () => {
    const saved = await operations().createSubmission(input)
    await operations().finishVerification(saved.id, saved.token, { ok: true })
    const previewToken = 'a'.repeat(43)
    sqlite.database
      .prepare(
        `INSERT INTO listing_submission_notifications
        (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
        VALUES (?,'github_issue','42','https://github.com/example/issues/42','reviewer',?)`
      )
      .run(saved.id, await hash(previewToken))

    await expect(
      operations().getReviewPreview({ id: saved.id, token: 'b'.repeat(43) })
    ).resolves.toBeNull()
    await expect(
      operations().getReviewPreview({ id: saved.id, token: previewToken })
    ).resolves.toMatchObject({
      category: 'tools',
      resourceLinks: [
        { label: 'Docs', url: 'https://example.com/docs' },
        { label: 'Support', url: 'https://example.com/support' }
      ],
      slug: 'example.com'
    })

    sqlite.database
      .prepare("UPDATE listing_submissions SET status='rejected' WHERE id=?")
      .run(saved.id)
    await expect(
      operations().getReviewPreview({ id: saved.id, token: previewToken })
    ).resolves.toBeNull()
  })

  it('fails closed when a verified migrated preview row contains malformed fields', async () => {
    const shared = operations()
    const saved = await shared.createSubmission(input)
    await shared.finishVerification(saved.id, saved.token, { ok: true })
    const previewToken = 'c'.repeat(43)
    sqlite.database
      .prepare(
        `INSERT INTO listing_submission_notifications
        (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
        VALUES (?,'github_issue','43','https://github.com/example/issues/43','reviewer',?)`
      )
      .run(saved.id, await hash(previewToken))

    const corruptions = [
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET category_slug='' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET category_slug='tools' WHERE id=?")
            .run(saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET content='' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET content=? WHERE id=?')
            .run(input.content, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET description=' ' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET description=? WHERE id=?')
            .run(input.description, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET name=' ' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET name=? WHERE id=?')
            .run(input.name, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            // The block key must match the slug (a CHECK), so the corruption clears it too.
            .prepare(
              "UPDATE listing_submissions SET slug=' ', block_key=NULL, block_covers_subdomains=NULL WHERE id=?"
            )
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submissions SET slug='example.com', block_key='example.com', block_covers_subdomains=1 WHERE id=?"
            )
            .run(saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET website='not a URL' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET website=? WHERE id=?')
            .run(input.website, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET website='javascript:alert(1)' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET website=? WHERE id=?')
            .run(input.website, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET website='http://127.0.0.1/private' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET website=? WHERE id=?')
            .run(input.website, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET logo_url='not an asset' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET logo_url=? WHERE id=?')
            .run(input.logoUrl, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET video_url='not an asset' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare('UPDATE listing_submissions SET video_url=? WHERE id=?')
            .run(input.videoUrl || null, saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET created_at='invalid' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET created_at='2026-08-01 00:00:00' WHERE id=?")
            .run(saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET label=' ' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET label='Docs' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET url='not a URL' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET url='https://example.com/docs' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET url='file:///tmp/private' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET url='https://example.com/docs' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id)
      },
      {
        corrupt: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET url='http://169.254.169.254/latest' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare(
              "UPDATE listing_submission_resource_links SET url='https://example.com/docs' WHERE submission_id=? AND sort_order=0"
            )
            .run(saved.id)
      }
    ]

    for (const corruption of corruptions) {
      corruption.corrupt()
      await expect(shared.getReviewPreview({ id: saved.id, token: previewToken })).rejects.toThrow(
        /Invalid D1 submission preview/u
      )
      corruption.restore()
    }
  })
})
