import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveRehearsalRateFingerprint } from '@serpdirectory/data-ops/replatform-preview-capability'
import type { SubmissionStatementPlan } from '@serpdirectory/data-ops/submission-plans'
import { type ApplicationSnapshot, readRemoteApplicationSnapshot } from './d1-preview-snapshot'
import { resolveSiteTarget, type SiteId } from './site-targets'

export interface RecoveryJournal {
  originalPublicationRunIds: string[]
  originalPublicationState: Record<string, unknown>
  ownedRateFingerprint: string | null
  rateFingerprintsBefore: string[]
  runId: string
  siteId: SiteId
  sourcePrivateBefore: Record<string, unknown>
  sourceSnapshotChecksum: string
  submissions: Array<{ id: string; listingId: string; publicationRunId: string }>
  targetPrivateBefore: Record<string, unknown>
  targetSnapshotChecksum: string
  version: number
}

export function assertRecoveredApplicationSnapshots(
  journal: RecoveryJournal,
  source: ApplicationSnapshot,
  target: ApplicationSnapshot
): void {
  if (
    journal.sourceSnapshotChecksum !== journal.targetSnapshotChecksum ||
    source.checksum !== journal.sourceSnapshotChecksum ||
    target.checksum !== journal.targetSnapshotChecksum ||
    source.checksum !== target.checksum
  )
    throw new Error('Recovered full application snapshot does not match journaled parity.')
}

export function adoptRecoveryRateFingerprint(
  journal: RecoveryJournal,
  discoveredSubmissionIds: readonly string[],
  currentFingerprints: readonly string[]
): RecoveryJournal {
  if (journal.ownedRateFingerprint) return journal
  if (discoveredSubmissionIds.length === 0) {
    if (JSON.stringify(currentFingerprints) !== JSON.stringify(journal.rateFingerprintsBefore))
      throw new Error('Unowned rate fingerprint state changed; manual recovery is required.')
    return journal
  }
  return {
    ...journal,
    ownedRateFingerprint: resolveRehearsalRateFingerprint(
      journal.rateFingerprintsBefore,
      currentFingerprints
    )
  }
}

interface Result {
  results?: Array<Record<string, unknown>>
  success?: boolean
}
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}
function plan(sql: string, params: unknown[] = []): SubmissionStatementPlan {
  return { sql, params }
}

export function buildRecoveryPlans(
  journal: RecoveryJournal,
  discoveredSubmissionIds: readonly string[]
): SubmissionStatementPlan[] {
  const recorded = new Map(journal.submissions.map(item => [item.id, item]))
  for (const id of discoveredSubmissionIds)
    if (!recorded.has(id))
      recorded.set(id, {
        id,
        listingId: `submission_${id}`,
        publicationRunId: `submission_publish_${id}`
      })
  const statements: SubmissionStatementPlan[] = []
  for (const item of recorded.values())
    statements.push(
      plan('UPDATE listing_submissions SET listing_id=NULL WHERE id=?', [item.id]),
      plan("UPDATE listings SET status='draft' WHERE id=?", [item.listingId]),
      plan('DELETE FROM listing_categories WHERE listing_id=?', [item.listingId]),
      plan('DELETE FROM listing_media WHERE listing_id=?', [item.listingId]),
      plan('DELETE FROM listing_resource_links WHERE listing_id=?', [item.listingId]),
      plan('DELETE FROM listing_faqs WHERE listing_id=?', [item.listingId]),
      plan('DELETE FROM listing_slug_redirects WHERE listing_id=?', [item.listingId]),
      plan('DELETE FROM listings WHERE id=?', [item.listingId]),
      plan('DELETE FROM publication_runs WHERE id=?', [item.publicationRunId]),
      plan('DELETE FROM listing_submission_notifications WHERE submission_id=?', [item.id]),
      plan('DELETE FROM listing_submission_events WHERE submission_id=?', [item.id]),
      plan('DELETE FROM listing_submission_resource_links WHERE submission_id=?', [item.id]),
      plan('DELETE FROM listing_submission_faqs WHERE submission_id=?', [item.id]),
      plan('DELETE FROM listing_submissions WHERE id=?', [item.id])
    )
  const state = journal.originalPublicationState
  statements.push(
    plan(
      'UPDATE publication_state SET version=?,manifest_id=?,checksum=?,published_at=? WHERE site_id=?',
      [state.version, state.manifest_id, state.checksum, state.published_at, journal.siteId]
    )
  )
  if (journal.ownedRateFingerprint)
    statements.push(
      plan('DELETE FROM listing_submission_rate_limits WHERE fingerprint_hash=?', [
        journal.ownedRateFingerprint
      ])
    )
  return statements
}

async function d1(databaseId: string, plans: SubmissionStatementPlan[]): Promise<Result[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ batch: plans.map(item => ({ sql: item.sql, params: item.params })) })
    }
  )
  const payload = (await response.json()) as { result?: Result[]; success?: boolean }
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(item => item.success === false)
  )
    throw new Error('Preview recovery D1 operation failed.')
  return payload.result
}

function objectFile(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Recovery input must be an object.')
  return value as Record<string, unknown>
}

async function main(): Promise<void> {
  const [journalPath, identityPath, outputPath] = process.argv.slice(2)
  if (!journalPath || !identityPath || !outputPath)
    throw new Error('Usage: d1-preview-submission-recovery.ts <journal> <fresh-identity> <output>')
  const journal = objectFile(journalPath) as unknown as RecoveryJournal
  const identity = objectFile(identityPath)
  const target = resolveSiteTarget(journal.siteId)
  if (journal.version !== 1 || journal.runId !== required('REPLATFORM_PREVIEW_RUN_ID'))
    throw new Error('Recovery journal run identity mismatch.')
  const verifiedAt = Date.parse(String(identity.verifiedAt || ''))
  const expected = identity.expected as Record<string, unknown> | undefined
  const observed = identity.observed as Record<string, unknown> | undefined
  if (
    identity.runId !== journal.runId ||
    !Number.isFinite(verifiedAt) ||
    Date.now() - verifiedAt > 120_000 ||
    expected?.siteId !== target.siteId ||
    expected?.targetDatabaseId !== required('CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID') ||
    JSON.stringify(expected) !== JSON.stringify(observed)
  )
    throw new Error('Fresh full identity verification is required before Preview recovery.')
  const targetId = required('CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID')
  const escapedRun = journal.runId
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
  const discovered = await d1(targetId, [
    plan("SELECT id FROM listing_submissions WHERE name LIKE ? ESCAPE '\\'", [
      `Preview Journey ${escapedRun}:%`
    ])
  ])
  const discoveredIds = (discovered[0]?.results ?? []).map(row => String(row.id))
  const fingerprintResult = await d1(targetId, [
    plan('SELECT fingerprint_hash FROM listing_submission_rate_limits ORDER BY fingerprint_hash')
  ])
  const currentFingerprints = (fingerprintResult[0]?.results ?? []).map(row =>
    String(row.fingerprint_hash)
  )
  const recoveryJournal = adoptRecoveryRateFingerprint(journal, discoveredIds, currentFingerprints)
  await d1(targetId, buildRecoveryPlans(recoveryJournal, discoveredIds))
  const audit = await d1(targetId, [
    plan('SELECT id FROM publication_runs ORDER BY id'),
    plan('SELECT * FROM publication_state WHERE site_id=?', [journal.siteId]),
    plan('SELECT fingerprint_hash FROM listing_submission_rate_limits ORDER BY fingerprint_hash')
  ])
  const runIds = (audit[0]?.results ?? []).map(row => String(row.id))
  const state = audit[1]?.results?.[0]
  const fingerprints = (audit[2]?.results ?? []).map(row => String(row.fingerprint_hash))
  if (
    JSON.stringify(runIds) !== JSON.stringify(journal.originalPublicationRunIds) ||
    JSON.stringify(state) !== JSON.stringify(journal.originalPublicationState) ||
    JSON.stringify(fingerprints) !== JSON.stringify(journal.rateFingerprintsBefore)
  )
    throw new Error('Preview recovery did not restore exact journaled state.')
  const sourceSnapshot = await readRemoteApplicationSnapshot(
    required('CLOUDFLARE_D1_PREVIEW_DATABASE_ID')
  )
  const targetSnapshot = await readRemoteApplicationSnapshot(targetId)
  assertRecoveredApplicationSnapshots(recoveryJournal, sourceSnapshot, targetSnapshot)
  writeFileSync(
    resolve(outputPath),
    `${JSON.stringify({ recovered: true, adoptedRateFingerprint: journal.ownedRateFingerprint === null ? recoveryJournal.ownedRateFingerprint : null, applicationSnapshotChecksum: targetSnapshot.checksum, discoveredSubmissionIds: discoveredIds, deletedSubmissionIds: [...new Set([...journal.submissions.map(item => item.id), ...discoveredIds])], restoredPublicationState: state, restoredPublicationRunIds: runIds, restoredRateFingerprints: fingerprints }, null, 2)}\n`
  )
}
if (process.argv[1]?.endsWith('d1-preview-submission-recovery.ts'))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
