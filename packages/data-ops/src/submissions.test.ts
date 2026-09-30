import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ActiveCheckedInSiteId } from '@serpdirectory/site-contract/active-site-ids'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSiteDatabase } from './client'
import { createSubmissionOperations, isSubmissionError, type SubmissionInput } from './submissions'
import { SqliteD1 } from './test-support'

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
    sqlite = new SqliteD1(':memory:', false)
    sqlite.database.exec(
      readFileSync(
        resolve(import.meta.dirname, '../../../d1/drizzle/0000_remarkable_manta.sql'),
        'utf8'
      )
    )
    for (const siteId of ['serp.software', 'pornvideodownloaders.com'] as const) {
      sqlite.database.prepare('INSERT INTO sites(id) VALUES (?)').run(siteId)
      sqlite.database
        .prepare(
          `INSERT INTO categories(site_id,slug,name,description,sort_order,is_active)
          VALUES (?,'tools','Tools','Tools',0,1)`
        )
        .run(siteId)
      sqlite.database
        .prepare(
          `INSERT INTO publication_state(site_id,version,checksum,published_at)
          VALUES (?,1,'before','2026-01-01T00:00:00.000Z')`
        )
        .run(siteId)
    }
  })

  function operations(siteId: ActiveCheckedInSiteId) {
    return createSubmissionOperations({
      client: createSiteDatabase(sqlite.asD1Database(), siteId),
      clock: () => new Date('2026-08-01T00:00:00.000Z')
    })
  }

  function lock(siteId: ActiveCheckedInSiteId): void {
    sqlite.database
      .prepare(
        `INSERT INTO migration_runs
          (id,site_id,schema_version,manifest_identity,input_checksum,target_checksum,
           affected_records,outcome)
        VALUES (?,?,1,?,'before','before',0,'started')`
      )
      .run(`d1-cutover-lock-v1:${siteId}:run-1`, siteId, `d1-cutover-lock-v1:${siteId}:run-1`)
  }

  it('creates normalized submissions atomically for both explicit Sites and stores only hashes', async () => {
    const serp = await operations('serp.software').createSubmission(input)
    const pvd = await operations('pornvideodownloaders.com').createSubmission(input)

    expect(serp.slug).toBe('example.com')
    expect(pvd.slug).toBe('example.com')
    expect(serp.token).not.toBe(pvd.token)
    const rows = sqlite.database
      .prepare(`SELECT site_id,access_token_hash FROM listing_submissions ORDER BY site_id`)
      .all() as Array<{ access_token_hash: string; site_id: string }>
    expect(rows).toEqual([
      { site_id: 'pornvideodownloaders.com', access_token_hash: await hash(pvd.token) },
      { site_id: 'serp.software', access_token_hash: await hash(serp.token) }
    ])
    expect(JSON.stringify(rows)).not.toContain(serp.token)
    expect(
      sqlite.database
        .prepare(
          `SELECT label,sort_order FROM listing_submission_resource_links
          WHERE submission_id=? ORDER BY sort_order`
        )
        .all(serp.id)
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
        .all(serp.id)
    ).toEqual([
      { question: 'First?', sort_order: 0 },
      { question: 'Second?', sort_order: 1 }
    ])
  })

  it('preserves public URL validation and Site-scoped capability access', async () => {
    await expect(
      operations('serp.software').createSubmission({
        ...input,
        website: 'http://127.0.0.1/private'
      })
    ).rejects.toMatchObject({ code: 'invalid_url' })

    const saved = await operations('serp.software').createSubmission(input)
    await expect(
      operations('pornvideodownloaders.com').getSubmission(saved.id, saved.token)
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await expect(
      operations('serp.software').getSubmission(saved.id, 'wrong-capability')
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('rolls back one of two concurrent verification transitions from the same snapshot', async () => {
    const saved = await operations('serp.software').createSubmission(input)
    const attempts = await Promise.allSettled([
      operations('serp.software').finishVerification(saved.id, saved.token, {
        code: 'badge_missing',
        ok: false
      }),
      operations('serp.software').finishVerification(saved.id, saved.token, {
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
    const saved = await operations('serp.software').createSubmission(input)
    const state = await operations('serp.software').finishVerification(saved.id, saved.token, {
      code: 'site_unreachable',
      ok: false
    })
    expect(sqlite.statements.some(statement => /\bTEMP\b/iu.test(statement.sql))).toBe(false)
    expect(state.verificationAttempts).toBe(0)
    expect(state.lastVerificationError).toBe('site_unreachable')

    for (let request = 0; request < 10; request += 1) {
      await operations('serp.software').consumeRateLimit('203.0.113.10')
    }
    await expect(
      operations('serp.software').consumeRateLimit('203.0.113.10')
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    await expect(
      operations('pornvideodownloaders.com').consumeRateLimit('203.0.113.10')
    ).resolves.toBeUndefined()
  })

  it('freezes every public write for only the locked Site without changing any row', async () => {
    const saved = await operations('serp.software').createSubmission(input)
    const eventCountBefore = sqlite.database
      .prepare('SELECT COUNT(*) AS count FROM listing_submission_events')
      .get()
    lock('serp.software')

    const frozen = await operations('serp.software')
      .consumeRateLimit('203.0.113.20')
      .catch(error => error as unknown)
    expect(isSubmissionError(frozen)).toBe(true)
    expect(frozen).toMatchObject({ code: 'cutover_frozen', status: 503 })
    await expect(
      operations('serp.software').createSubmission({
        ...input,
        website: 'https://another.example/'
      })
    ).rejects.toMatchObject({ code: 'cutover_frozen', status: 503 })
    await expect(
      operations('serp.software').beginVerification(saved.id, saved.token)
    ).rejects.toMatchObject({ code: 'cutover_frozen', status: 503 })
    await expect(
      operations('serp.software').finishVerification(saved.id, saved.token, { ok: true })
    ).rejects.toMatchObject({ code: 'cutover_frozen', status: 503 })

    expect(
      sqlite.database.prepare('SELECT COUNT(*) AS count FROM listing_submission_rate_limits').get()
    ).toEqual({ count: 0 })
    expect(
      sqlite.database.prepare('SELECT COUNT(*) AS count FROM listing_submissions').get()
    ).toEqual({ count: 1 })
    expect(
      sqlite.database.prepare('SELECT COUNT(*) AS count FROM listing_submission_events').get()
    ).toEqual(eventCountBefore)
    expect(
      sqlite.database
        .prepare('SELECT status,verification_attempts FROM listing_submissions WHERE id=?')
        .get(saved.id)
    ).toEqual({ status: 'pending_badge', verification_attempts: 0 })

    await expect(
      operations('pornvideodownloaders.com').consumeRateLimit('203.0.113.20')
    ).resolves.toBeUndefined()
  })

  it('gates private previews by Site, digest, and verified status and revokes them after decision', async () => {
    const saved = await operations('serp.software').createSubmission(input)
    await operations('serp.software').finishVerification(saved.id, saved.token, { ok: true })
    const previewToken = 'a'.repeat(43)
    sqlite.database
      .prepare(
        `INSERT INTO listing_submission_notifications
        (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
        VALUES (?,'github_issue','42','https://github.com/example/issues/42','reviewer',?)`
      )
      .run(saved.id, await hash(previewToken))

    await expect(
      operations('serp.software').getReviewPreview({ id: saved.id, token: 'b'.repeat(43) })
    ).resolves.toBeNull()
    await expect(
      operations('pornvideodownloaders.com').getReviewPreview({ id: saved.id, token: previewToken })
    ).resolves.toBeNull()
    await expect(
      operations('serp.software').getReviewPreview({ id: saved.id, token: previewToken })
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
      operations('serp.software').getReviewPreview({ id: saved.id, token: previewToken })
    ).resolves.toBeNull()
  })

  it('fails closed when a verified migrated preview row contains malformed fields', async () => {
    const shared = operations('serp.software')
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
            .prepare("UPDATE listing_submissions SET slug=' ' WHERE id=?")
            .run(saved.id),
        restore: () =>
          sqlite.database
            .prepare("UPDATE listing_submissions SET slug='example.com' WHERE id=?")
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
