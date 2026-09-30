import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sanitizePvdPreview } from './d1-preview-sanitize'
import {
  buildExpectedLegacySource,
  type LegacySourceObservation
} from './d1-preview-source-classify'
import { applicationColumnInventory } from './d1-replatform-inventory'

const sha = 'a'.repeat(40)
const now = Date.parse('2026-09-25T04:00:00.000Z')
const databaseId = 'f92694b0-af7d-4c13-91f2-ee0393af9bdd'
const databaseName = 'pornvideo-downloaders-preview'
const workerName = 'pornvideodownloaders-preview'
const expected = buildExpectedLegacySource('pornvideodownloaders.com')

const env = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_REF:
    'owner/repo/.github/workflows/rehearse-d1-replatform-preview.yml@refs/heads/main',
  WORKER_PRODUCTION_CONFIRM: 'rehearse-pornvideodownloaders.com-preview',
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CLOUDFLARE_API_TOKEN: 'token',
  CLOUDFLARE_D1_PREVIEW_DATABASE_ID: databaseId,
  CLOUDFLARE_D1_PREVIEW_DATABASE_NAME: databaseName,
  REPLATFORM_PREVIEW_RUN_ID: 'run-1'
}

const identity = {
  expected: {
    siteId: 'pornvideodownloaders.com',
    environment: 'preview',
    protectedEnvironment: 'pornvideodownloaders-preview',
    sourceDatabaseId: databaseId,
    sourceDatabaseName: databaseName,
    workerName
  },
  observed: {
    siteId: 'pornvideodownloaders.com',
    environment: 'preview',
    protectedEnvironment: 'pornvideodownloaders-preview',
    sourceDatabaseId: databaseId,
    sourceDatabaseName: databaseName,
    workerName
  },
  runId: 'run-1',
  verifiedAt: '2026-09-25T03:59:30.000Z',
  workerState: 'existing-exact'
}

function observation(privateState: boolean): LegacySourceObservation {
  const tables = structuredClone(expected.applicationTables)
  if (privateState) {
    tables.listing_submissions = { count: 1, checksum: 'submission-private' }
    tables.listing_submission_events = { count: 1, checksum: 'event-private' }
    tables.listing_submission_rate_limits = { count: 1, checksum: 'rate-private' }
  }
  return {
    applicationSnapshot: {
      checksum: privateState ? 'private-before' : expected.applicationSnapshotChecksum,
      migrationNames: expected.migrationNames,
      tables
    },
    hasMigrationLedger: true,
    migrationNames: expected.migrationNames,
    schemaFingerprint: expected.schemaFingerprint,
    siteIds: ['pornvideodownloaders.com'],
    unexpectedUserObjects: []
  }
}

function response(results: Array<Array<Record<string, unknown>>>): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: results.map(rows => ({ success: true, results: rows }))
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

const graphRows = [
  [
    {
      id: 'submission-1',
      site_id: 'pornvideodownloaders.com',
      status: 'pending_badge',
      listing_id: null
    }
  ],
  [{ id: 'event-1', submission_id: 'submission-1' }],
  [{ fingerprint_hash: 'fingerprint-1' }],
  [],
  [],
  []
] as Array<Array<Record<string, unknown>>>
const proofTables = [
  'listing_submissions',
  'listing_submission_events',
  'listing_submission_rate_limits',
  'listing_submission_resource_links',
  'listing_submission_faqs',
  'listing_submission_notifications'
] as const
const reviewedPrivateTableProof = Object.fromEntries(
  proofTables.map((table, index) => {
    const payload = graphRows[index]
      .map(row =>
        JSON.stringify(applicationColumnInventory[table].map(column => row[column] ?? null))
      )
      .sort()
      .join('\n')
    return [
      table,
      {
        count: graphRows[index].length,
        checksum: createHash('sha256').update(payload).digest('hex')
      }
    ]
  })
) as Record<(typeof proofTables)[number], { checksum: string; count: number }>

function graphResponse(): Response {
  return response(graphRows)
}

function harness(
  observations: LegacySourceObservation[],
  fetcher = vi.fn(async () => graphResponse())
) {
  const directory = mkdtempSync(resolve(tmpdir(), 'pvd-sanitize-'))
  return {
    backupPath: resolve(`.wrangler/backups/pornvideodownloaders-com/preview/${sha}.sql`),
    dependencies: {
      fetcher,
      now: () => now,
      observe: vi.fn(async () => {
        const next = observations.shift()
        if (!next) throw new Error('Unexpected observation.')
        return next
      }),
      readFile: () => Buffer.from('retained-source-backup'),
      reviewedPrivateTableProof
    },
    journalPath: resolve(directory, 'journal.json')
  }
}

describe('protected PVD Preview sanitization', () => {
  it('deletes only the exact known graph after identity, backup, public, schema, and ledger proof', async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch: Array<{ sql: string }> }
      return body.batch[0]?.sql.includes('FROM "listing_submissions"')
        ? graphResponse()
        : response(body.batch.map(() => []))
    })
    const setup = harness([observation(true), observation(false)], fetcher)
    const result = await sanitizePvdPreview({
      backupPath: setup.backupPath,
      dependencies: setup.dependencies,
      env,
      identity,
      journalPath: setup.journalPath
    })

    expect(result).toMatchObject({
      mode: 'sanitized',
      submissionId: 'submission-1',
      eventId: 'event-1',
      rateFingerprint: 'fingerprint-1',
      afterChecksum: expected.applicationSnapshotChecksum
    })
    const mutation = fetcher.mock.calls
      .map(
        call =>
          JSON.parse(String(call[1]?.body)) as {
            batch: Array<{ params: unknown[]; sql: string }>
          }
      )
      .find(body => body.batch.some(plan => plan.sql.startsWith('DELETE')))
    expect(mutation?.batch.map(plan => plan.sql)).toEqual([
      expect.stringContaining('DELETE FROM "listing_submission_events" WHERE'),
      expect.stringContaining('changes()=1'),
      expect.stringContaining('DELETE FROM "listing_submission_rate_limits" WHERE'),
      expect.stringContaining('changes()=1'),
      expect.stringContaining('DELETE FROM "listing_submissions" WHERE'),
      expect.stringContaining('changes()=1')
    ])
    expect([
      mutation?.batch[0].params.length,
      mutation?.batch[2].params.length,
      mutation?.batch[4].params.length
    ]).toEqual([
      applicationColumnInventory.listing_submission_events.length,
      applicationColumnInventory.listing_submission_rate_limits.length,
      applicationColumnInventory.listing_submissions.length
    ])
    expect(JSON.parse(readFileSync(setup.journalPath, 'utf8'))).toMatchObject({
      backupSha256: result.backupSha256,
      beforeChecksum: 'private-before',
      expectedAfterChecksum: expected.applicationSnapshotChecksum,
      submissionId: 'submission-1'
    })
  })

  it('is a verified no-op after a prior successful sanitization', async () => {
    const fetcher = vi.fn(async () => response([[], [], [], [], [], []]))
    const setup = harness([observation(false)], fetcher)
    await expect(
      sanitizePvdPreview({
        backupPath: setup.backupPath,
        dependencies: setup.dependencies,
        env,
        identity,
        journalPath: setup.journalPath
      })
    ).resolves.toMatchObject({ mode: 'already-sanitized', submissionId: null })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('re-observes and retries only the same exact graph after an uncertain response', async () => {
    let mutationAttempts = 0
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch: Array<{ sql: string }> }
      if (body.batch[0]?.sql.includes('FROM "listing_submissions"')) return graphResponse()
      mutationAttempts += 1
      if (mutationAttempts === 1)
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'timeout' }] }), {
          status: 504
        })
      return response(body.batch.map(() => []))
    })
    const setup = harness([observation(true), observation(true), observation(false)], fetcher)
    await expect(
      sanitizePvdPreview({
        backupPath: setup.backupPath,
        dependencies: setup.dependencies,
        env,
        identity,
        journalPath: setup.journalPath
      })
    ).resolves.toMatchObject({
      mode: 'sanitized',
      afterChecksum: expected.applicationSnapshotChecksum
    })
    expect(mutationAttempts).toBe(2)
  })

  it('fails closed on wrong workflow, public drift, or any graph broader than 1/1/1', async () => {
    const setup = harness([observation(true)])
    await expect(
      sanitizePvdPreview({
        backupPath: setup.backupPath,
        dependencies: setup.dependencies,
        env: { ...env, GITHUB_REF: 'refs/heads/topic' },
        identity,
        journalPath: setup.journalPath
      })
    ).rejects.toThrow('protected rehearsal workflow')

    const drift = observation(true)
    drift.applicationSnapshot.tables.listings = { count: 999, checksum: 'drift' }
    const driftSetup = harness([drift])
    await expect(
      sanitizePvdPreview({
        backupPath: driftSetup.backupPath,
        dependencies: driftSetup.dependencies,
        env,
        identity,
        journalPath: driftSetup.journalPath
      })
    ).rejects.toThrow('public/audit table listings differs')

    const broadFetcher = vi.fn(async () =>
      response([
        [
          {
            id: 'one',
            site_id: 'pornvideodownloaders.com',
            status: 'pending_badge',
            listing_id: null
          },
          {
            id: 'two',
            site_id: 'pornvideodownloaders.com',
            status: 'pending_badge',
            listing_id: null
          }
        ],
        [{ id: 'event', submission_id: 'one' }],
        [{ fingerprint_hash: 'fingerprint' }],
        [],
        [],
        []
      ])
    )
    const broadSetup = harness([observation(true)], broadFetcher)
    await expect(
      sanitizePvdPreview({
        backupPath: broadSetup.backupPath,
        dependencies: broadSetup.dependencies,
        env,
        identity,
        journalPath: broadSetup.journalPath
      })
    ).rejects.toThrow('does not match the reviewed private-row digest')

    const replacementGraph = structuredClone(graphRows)
    replacementGraph[0][0].id = 'different-submission'
    replacementGraph[1][0].submission_id = 'different-submission'
    const replacementSetup = harness(
      [observation(true)],
      vi.fn(async () => response(replacementGraph))
    )
    await expect(
      sanitizePvdPreview({
        backupPath: replacementSetup.backupPath,
        dependencies: replacementSetup.dependencies,
        env,
        identity,
        journalPath: replacementSetup.journalPath
      })
    ).rejects.toThrow('does not match the reviewed private-row digest')
  })
})
