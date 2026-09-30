import { createHash, randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createReplatformPreviewCapability,
  resolveRehearsalRateFingerprint
} from '@serpdirectory/data-ops/replatform-preview-capability'
import {
  buildApproveSubmissionPlans,
  buildRejectSubmissionPlans,
  type SubmissionStatementPlan,
  selectSubmissionForDecisionPlan
} from '@serpdirectory/data-ops/submission-plans'
import { readRemoteApplicationSnapshot } from './d1-preview-snapshot'
import { resolveSiteTarget } from './site-targets'

interface Result {
  results?: Array<Record<string, unknown>>
  success?: boolean
}
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
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
      body: JSON.stringify({ batch: plans.map(plan => ({ sql: plan.sql, params: plan.params })) })
    }
  )
  const payload = (await response.json()) as { result?: Result[]; success?: boolean }
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(item => item.success === false)
  )
    throw new Error('Preview journey D1 operation failed.')
  return payload.result
}
function plan(sql: string, params: unknown[] = []): SubmissionStatementPlan {
  return { sql, params }
}
function measuredPrivateCounts(value: Record<string, unknown> | undefined, label: string) {
  if (
    !value ||
    ['capabilityRows', 'notificationSecretRows', 'rateLimitRows'].some(
      key =>
        typeof value[key] !== 'number' || !Number.isInteger(value[key]) || Number(value[key]) < 0
    )
  )
    throw new Error(`${label} private-state measurement is malformed.`)
  return value
}
async function post(url: URL, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-replatform-preview-intake': required('REPLATFORM_PREVIEW_INTAKE_SECRET')
    },
    body: JSON.stringify(body)
  })
  const payload = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    const reason = payload.lastVerificationError ?? payload.code ?? 'unknown'
    throw new Error(`Preview submission request failed (${response.status}): ${String(reason)}`)
  }
  return payload
}
async function exerciseRateLimit(base: URL): Promise<{ attempts: number; status: number }> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await fetch(new URL('/api/submissions', base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-replatform-preview-intake': required('REPLATFORM_PREVIEW_INTAKE_SECRET')
      },
      body: JSON.stringify({ invalid: true })
    })
    if (response.status === 429) return { attempts: attempt, status: response.status }
    if (response.status !== 400)
      throw new Error(`Unexpected rate-limit probe status ${response.status}.`)
  }
  throw new Error('Preview Submission rate limit did not fail closed with 429.')
}
async function createAndVerify(base: URL, siteId: string, suffix: string) {
  const hostname = base.hostname
  const capabilityToken = await createReplatformPreviewCapability({
    expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
    runId: required('REPLATFORM_PREVIEW_RUN_ID'),
    secret: required('REPLATFORM_PREVIEW_SIGNING_SECRET'),
    slug: hostname
  })
  const website = new URL(
    `/api/replatform/badge-fixture?slug=${hostname}&token=${capabilityToken}`,
    base
  ).toString()
  const created = await post(new URL('/api/submissions', base), {
    category: 'video-downloaders',
    content: `Controlled Preview submission journey ${suffix}.`,
    description: `Controlled Preview submission journey ${suffix}.`,
    faqs: [],
    logoUrl: new URL(`/badge/featured-on-${siteId}-light.svg`, base).toString(),
    name: `Preview Journey ${suffix}`,
    resourceLinks: [],
    videoUrl: '',
    website
  })
  const id = String(created.id)
  const submissionToken = String(created.token)
  const verified = await post(new URL(`/api/submissions/${id}/verify`, base), {
    token: submissionToken
  })
  if (verified.status !== 'verified')
    throw new Error('Real Preview badge verification did not reach verified state.')
  return { id, token: submissionToken, slug: String(verified.slug) }
}
async function main(): Promise<void> {
  const [siteValue, output, journalPath] = process.argv.slice(2)
  if (!siteValue || !output || !journalPath)
    throw new Error('Usage: d1-preview-submission-journey.ts <site> <output.json> <journal.json>')
  const siteId = resolveSiteTarget(siteValue).siteId
  const base = new URL(required('PREVIEW_BASE_URL'))
  if (base.protocol !== 'https:' || base.hostname === siteId)
    throw new Error('Journey requires an isolated HTTPS Preview host.')
  const targetId = required('CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID')
  const sourceId = required('CLOUDFLARE_D1_PREVIEW_DATABASE_ID')
  const privateSql = `SELECT
    (SELECT COUNT(*) FROM listing_submissions) capabilityRows,
    (SELECT COUNT(*) FROM listing_submission_notifications WHERE preview_token_hash IS NOT NULL) notificationSecretRows,
    (SELECT COUNT(*) FROM listing_submission_rate_limits) rateLimitRows`
  const sourceBefore = measuredPrivateCounts(
    (await d1(sourceId, [plan(privateSql)]))[0]?.results?.[0],
    'Source before'
  )
  const targetBefore = measuredPrivateCounts(
    (await d1(targetId, [plan(privateSql)]))[0]?.results?.[0],
    'Target before'
  )
  if (Object.values(targetBefore).some(value => Number(value) !== 0))
    throw new Error('Controlled Preview target contains copied private state before journeys.')
  const rateBefore = new Set(
    (
      (await d1(targetId, [plan('SELECT fingerprint_hash FROM listing_submission_rate_limits')]))[0]
        ?.results ?? []
    ).map(row => String(row.fingerprint_hash))
  )
  const publication = (
    await d1(targetId, [plan('SELECT * FROM publication_state WHERE site_id=?', [siteId])])
  )[0]?.results?.[0]
  if (
    !publication ||
    typeof publication.version !== 'number' ||
    typeof publication.checksum !== 'string'
  )
    throw new Error('Missing Preview publication snapshot.')
  const rehearsalRunId = required('REPLATFORM_PREVIEW_RUN_ID')
  const publicationRunIds =
    (await d1(targetId, [plan('SELECT id FROM publication_runs ORDER BY id')]))[0]?.results?.map(
      row => String(row.id)
    ) ?? []
  const sourceSnapshot = await readRemoteApplicationSnapshot(sourceId)
  const targetSnapshot = await readRemoteApplicationSnapshot(targetId)
  if (sourceSnapshot.checksum !== targetSnapshot.checksum)
    throw new Error('Pre-journey source and target application snapshots differ.')
  const journal = {
    version: 1,
    siteId,
    runId: rehearsalRunId,
    phase: 'before-intake',
    originalPublicationState: publication,
    originalPublicationRunIds: publicationRunIds,
    sourcePrivateBefore: sourceBefore,
    sourceSnapshotChecksum: sourceSnapshot.checksum,
    targetPrivateBefore: targetBefore,
    targetSnapshotChecksum: targetSnapshot.checksum,
    rateFingerprintsBefore: [...rateBefore],
    submissions: [] as Array<{ id: string; listingId: string; publicationRunId: string }>,
    ownedRateFingerprint: null as string | null
  }
  const persistJournal = (): void => {
    const temporary = `${journalPath}.tmp`
    writeFileSync(resolve(temporary), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
    renameSync(resolve(temporary), resolve(journalPath))
  }
  persistJournal()

  const approved = await createAndVerify(
    base,
    siteId,
    `${rehearsalRunId}:approved:${randomBytes(4).toString('hex')}`
  )
  journal.submissions.push({
    id: approved.id,
    listingId: `submission_${approved.id}`,
    publicationRunId: `submission_publish_${approved.id}`
  })
  journal.phase = 'after-approved-intake'
  persistJournal()
  const rateAfterFirstRequest =
    (
      await d1(targetId, [plan('SELECT fingerprint_hash FROM listing_submission_rate_limits')])
    )[0]?.results?.map(row => String(row.fingerprint_hash)) ?? []
  const ownedRateFingerprint = resolveRehearsalRateFingerprint(
    [...rateBefore],
    rateAfterFirstRequest
  )
  journal.ownedRateFingerprint = ownedRateFingerprint
  persistJournal()
  const previewToken = randomBytes(32).toString('base64url')
  const previewHash = createHash('sha256').update(previewToken).digest('hex')
  await d1(targetId, [
    plan(
      `INSERT INTO listing_submission_notifications
    (submission_id,channel,external_id,external_url,recipient,preview_token_hash)
    VALUES (?,'github_issue',?,?,?,?)`,
      [
        approved.id,
        `preview-${approved.id}`,
        'https://example.invalid/preview',
        'preview-maintainer',
        previewHash
      ]
    )
  ])
  journal.phase = 'after-notification'
  persistJournal()
  const previewResponse = await fetch(
    new URL(`/admin/submissions/${approved.id}/preview/${previewToken}/`, base)
  )
  if (!previewResponse.ok || !(await previewResponse.text()).includes('Preview Journey'))
    throw new Error('Private Preview journey failed.')
  const selected = (await d1(targetId, [selectSubmissionForDecisionPlan(approved.id, siteId)]))[0]
    ?.results?.[0]
  if (!selected || selected.status !== 'verified')
    throw new Error('Verified approval snapshot missing.')
  const listingId = `submission_${approved.id}`
  const manifestId = `verified-submission-${approved.id}`
  const runId = `submission_publish_${approved.id}`
  const afterChecksum = createHash('sha256')
    .update(`${selected.checksum}\n${manifestId}\n${Number(selected.version) + 1}`)
    .digest('hex')
  await d1(
    targetId,
    buildApproveSubmissionPlans({
      afterChecksum,
      beforeChecksum: String(selected.checksum),
      listingId,
      manifestId,
      now: new Date().toISOString(),
      reviewer: 'preview-rehearsal',
      runId,
      siteId,
      slug: approved.slug,
      submissionId: approved.id,
      version: Number(selected.version)
    })
  )
  const approvedRow = (
    await d1(targetId, [plan('SELECT status FROM listing_submissions WHERE id=?', [approved.id])])
  )[0]?.results?.[0]
  if (approvedRow?.status !== 'approved') throw new Error('Preview approval journey failed.')
  journal.phase = 'after-approval'
  persistJournal()
  const targetPeak = measuredPrivateCounts(
    (await d1(targetId, [plan(privateSql)]))[0]?.results?.[0],
    'Target peak'
  )

  await d1(targetId, [
    plan("UPDATE listing_submissions SET listing_id=NULL,status='verified' WHERE id=?", [
      approved.id
    ]),
    plan("UPDATE listings SET status='draft' WHERE id=?", [listingId]),
    plan('DELETE FROM listing_categories WHERE listing_id=?', [listingId]),
    plan('DELETE FROM listing_media WHERE listing_id=?', [listingId]),
    plan('DELETE FROM listing_resource_links WHERE listing_id=?', [listingId]),
    plan('DELETE FROM listing_faqs WHERE listing_id=?', [listingId]),
    plan('DELETE FROM listings WHERE id=?', [listingId]),
    plan('DELETE FROM publication_runs WHERE id=?', [runId]),
    plan(
      'UPDATE publication_state SET version=?,manifest_id=?,checksum=?,published_at=? WHERE site_id=?',
      [
        publication.version,
        publication.manifest_id,
        publication.checksum,
        publication.published_at,
        siteId
      ]
    ),
    plan('DELETE FROM listing_submission_notifications WHERE submission_id=?', [approved.id]),
    plan('DELETE FROM listing_submission_events WHERE submission_id=?', [approved.id]),
    plan('DELETE FROM listing_submission_resource_links WHERE submission_id=?', [approved.id]),
    plan('DELETE FROM listing_submission_faqs WHERE submission_id=?', [approved.id]),
    plan('DELETE FROM listing_submissions WHERE id=?', [approved.id])
  ])

  const rejected = await createAndVerify(
    base,
    siteId,
    `${rehearsalRunId}:rejected:${randomBytes(4).toString('hex')}`
  )
  journal.submissions.push({
    id: rejected.id,
    listingId: `submission_${rejected.id}`,
    publicationRunId: `submission_publish_${rejected.id}`
  })
  journal.phase = 'after-rejected-intake'
  persistJournal()
  await d1(
    targetId,
    buildRejectSubmissionPlans({
      now: new Date().toISOString(),
      reviewer: 'preview-rehearsal',
      siteId,
      submissionId: rejected.id
    })
  )
  const rejectedRow = (
    await d1(targetId, [plan('SELECT status FROM listing_submissions WHERE id=?', [rejected.id])])
  )[0]?.results?.[0]
  if (rejectedRow?.status !== 'rejected') throw new Error('Preview rejection journey failed.')
  journal.phase = 'after-rejection'
  persistJournal()
  const rateLimitEvidence = await exerciseRateLimit(base)
  journal.phase = 'after-rate-limit'
  persistJournal()
  await d1(targetId, [
    plan('DELETE FROM listing_submission_events WHERE submission_id=?', [rejected.id]),
    plan('DELETE FROM listing_submission_resource_links WHERE submission_id=?', [rejected.id]),
    plan('DELETE FROM listing_submission_faqs WHERE submission_id=?', [rejected.id]),
    plan('DELETE FROM listing_submissions WHERE id=?', [rejected.id])
  ])
  await d1(targetId, [
    plan('DELETE FROM listing_submission_rate_limits WHERE fingerprint_hash=?', [
      ownedRateFingerprint
    ])
  ])
  const sourceAfter = measuredPrivateCounts(
    (await d1(sourceId, [plan(privateSql)]))[0]?.results?.[0],
    'Source after'
  )
  const targetAfter = measuredPrivateCounts(
    (await d1(targetId, [plan(privateSql)]))[0]?.results?.[0],
    'Target after'
  )
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter))
    throw new Error('Source Preview D1 changed during target journeys.')
  const generated = {
    capabilityRows: Math.max(
      0,
      Number(targetPeak?.capabilityRows) - Number(targetBefore?.capabilityRows)
    ),
    notificationSecretRows: Math.max(
      0,
      Number(targetPeak?.notificationSecretRows) - Number(targetBefore?.notificationSecretRows)
    ),
    rateLimitRows: Math.max(
      0,
      Number(targetPeak?.rateLimitRows) - Number(targetBefore?.rateLimitRows)
    )
  }
  if (Object.values(targetAfter ?? {}).some(value => Number(value) !== 0))
    throw new Error('Preview journey cleanup left private rows behind.')
  journal.phase = 'inline-cleanup-complete'
  persistJournal()
  writeFileSync(
    resolve(output),
    `${JSON.stringify({ siteId, intake: true, rateLimit: rateLimitEvidence.status === 429, rateLimitEvidence: { ...rateLimitEvidence, ownedFingerprint: ownedRateFingerprint }, badgeVerification: true, privatePreview: true, approval: true, rejection: true, sourceUnchanged: true, targetPrivateRowsAfterCleanup: targetAfter, deletedOnlyGeneratedIds: [approved.id, rejected.id, listingId, runId, ownedRateFingerprint], copiedProduction: targetBefore, previewGenerated: generated }, null, 2)}\n`
  )
}
void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
