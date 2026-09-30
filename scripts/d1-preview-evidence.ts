import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  assertRemoteIdentity,
  freshMigrationChecksum,
  previewReceiptSha256,
  previewRehearsalSecretNames
} from './d1-replatform-cutover'
import { canonicalLegacyMigrationNames } from './d1-replatform-inventory'
import { resolveSiteTarget } from './site-targets'

function argumentsMap(args: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || !value) throw new Error('Every evidence flag needs a value.')
    values.set(flag, value)
  }
  return values
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)
  if (!value) throw new Error(`Missing ${flag}.`)
  return value
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

function readJson(path: string): Record<string, unknown> {
  const source = readFileSync(resolve(path), 'utf8').trim()
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    const line = source.split('\n').findLast(candidate => candidate.trim().startsWith('{'))
    if (!line) throw new Error(`${path} contains no JSON evidence.`)
    value = JSON.parse(line)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} evidence must be an object.`)
  return value as Record<string, unknown>
}

const values = argumentsMap(process.argv.slice(2))
const siteId = resolveSiteTarget(required(values, '--site')).siteId
const target = resolveSiteTarget(siteId)
const previewDataPolicy = requiredEnv('D1_PREVIEW_DATA_POLICY')
const sanitizationJournalPath = values.get('--sanitization-journal')
const sanitizationResultPath = values.get('--sanitization-result')
const sanitizationJournal = sanitizationJournalPath ? readJson(sanitizationJournalPath) : undefined
const sanitizationResult = sanitizationResultPath ? readJson(sanitizationResultPath) : undefined
if (
  (siteId === 'pornvideodownloaders.com' &&
    (previewDataPolicy !== 'sanitized-snapshot' || !sanitizationJournal || !sanitizationResult)) ||
  (siteId === 'serp.software' &&
    (previewDataPolicy !== 'controlled-fixtures' || sanitizationJournal || sanitizationResult))
)
  throw new Error('Preview sanitization evidence does not match the selected Site data policy.')
const identity = readJson(required(values, '--identity'))
const initialWorkerObservation = readJson(required(values, '--initial-worker-deployment'))
const secretWorkerObservation = readJson(required(values, '--secret-worker-deployment'))
const workerAttestation = readJson(required(values, '--worker-attestation'))
const sourceClassification = readJson(required(values, '--source-classification'))
const sourceFinalClassification = readJson(required(values, '--source-final-classification'))
const sourceControlled = readJson(required(values, '--source-controlled'))
const sourceRepeatImport = readFileSync(resolve(required(values, '--source-repeat-import')), 'utf8')
const firstImport = readFileSync(resolve(required(values, '--first-import')), 'utf8')
const first = readJson(required(values, '--first-parity'))
const repeat = readJson(required(values, '--repeat-parity'))
const preflight = readJson(required(values, '--preflight'))
const measured = readJson(required(values, '--measurement'))
const repeatMeasured = readJson(required(values, '--repeat-measurement'))
const postJourneyMeasured = readJson(required(values, '--post-journey-measurement'))
const catalog = readJson(required(values, '--catalog-journeys'))
const submission = readJson(required(values, '--submission-journeys'))
const submissionCleanup = readJson(required(values, '--submission-cleanup'))
const rollbackSource = readJson(required(values, '--rollback-source'))
const rollbackTarget = readJson(required(values, '--rollback-target'))
assertRemoteIdentity(siteId, 'preview', initialWorkerObservation)
const initialWorkerDeployment = initialWorkerObservation.activeDeployment as Record<string, unknown>
if (
  !initialWorkerDeployment ||
  initialWorkerDeployment.siteId !== siteId ||
  initialWorkerDeployment.generation !== 'legacy' ||
  initialWorkerDeployment.credentialFree !== true ||
  JSON.stringify(initialWorkerDeployment.absentSecretNames) !==
    JSON.stringify(previewRehearsalSecretNames) ||
  initialWorkerDeployment.captureSource !== 'wrangler-deploy-output' ||
  initialWorkerDeployment.capturedVersionId !== initialWorkerDeployment.versionId ||
  initialWorkerDeployment.commitSha !== process.env.GITHUB_SHA ||
  initialWorkerDeployment.serviceName !== process.env.CLOUDFLARE_WORKER_PREVIEW_NAME ||
  initialWorkerDeployment.sourceDatabaseId !== process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID ||
  initialWorkerDeployment.hostname !== new URL(requiredEnv('PREVIEW_BASE_URL')).hostname ||
  initialWorkerDeployment.trafficPercentage !== 100 ||
  typeof initialWorkerDeployment.deploymentId !== 'string' ||
  !initialWorkerDeployment.deploymentId ||
  typeof initialWorkerDeployment.versionId !== 'string' ||
  !initialWorkerDeployment.versionId ||
  typeof initialWorkerDeployment.scriptEtag !== 'string' ||
  !initialWorkerDeployment.scriptEtag
)
  throw new Error('Initial source-bound Worker deployment evidence is incomplete or mismatched.')
assertRemoteIdentity(siteId, 'preview', secretWorkerObservation)
const secretWorkerDeployment = secretWorkerObservation.activeDeployment as Record<string, unknown>
if (
  !secretWorkerDeployment ||
  secretWorkerDeployment.siteId !== siteId ||
  secretWorkerDeployment.generation !== 'legacy' ||
  secretWorkerDeployment.transitionSource !== 'wrangler-secret-bulk' ||
  secretWorkerDeployment.previousDeploymentId !== initialWorkerDeployment.deploymentId ||
  secretWorkerDeployment.previousVersionId !== initialWorkerDeployment.versionId ||
  secretWorkerDeployment.deploymentId === initialWorkerDeployment.deploymentId ||
  secretWorkerDeployment.versionId === initialWorkerDeployment.versionId ||
  secretWorkerDeployment.scriptEtag !== initialWorkerDeployment.scriptEtag ||
  secretWorkerDeployment.commitSha !== process.env.GITHUB_SHA ||
  secretWorkerDeployment.serviceName !== process.env.CLOUDFLARE_WORKER_PREVIEW_NAME ||
  secretWorkerDeployment.sourceDatabaseId !== process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID ||
  secretWorkerDeployment.hostname !== new URL(requiredEnv('PREVIEW_BASE_URL')).hostname ||
  secretWorkerDeployment.trafficPercentage !== 100 ||
  JSON.stringify(secretWorkerDeployment.secretNames) !== JSON.stringify(previewRehearsalSecretNames)
)
  throw new Error('Secret-bearing Worker deployment evidence is incomplete or mismatched.')
const sourcePrivateCounts = sourceControlled.sourcePrivateCounts as Record<string, unknown>
if (
  sourceClassification.classification !== 'blank' &&
  sourceClassification.classification !== 'controlled-populated'
)
  throw new Error('Legacy Preview source classification is invalid.')
const classifiedExpected = sourceClassification.expected as Record<string, unknown>
const finalExpected = sourceFinalClassification.expected as Record<string, unknown>
const finalObserved = sourceFinalClassification.observed as Record<string, unknown>
const finalMigrationNames = finalObserved?.migrationNames as unknown
const finalSiteIds = finalObserved?.siteIds as unknown
const finalUnexpectedObjects = finalObserved?.unexpectedUserObjects as unknown
if (
  sourceFinalClassification.classification !== 'controlled-populated' ||
  JSON.stringify(finalExpected?.migrationNames) !== JSON.stringify(canonicalLegacyMigrationNames) ||
  JSON.stringify(finalMigrationNames) !== JSON.stringify(canonicalLegacyMigrationNames) ||
  finalObserved?.schemaFingerprint !== finalExpected?.schemaFingerprint ||
  JSON.stringify(finalSiteIds) !== JSON.stringify([siteId]) ||
  JSON.stringify(finalUnexpectedObjects) !== JSON.stringify([]) ||
  (finalObserved?.applicationSnapshot as { checksum?: unknown })?.checksum !==
    finalExpected?.applicationSnapshotChecksum
)
  throw new Error('Final legacy source classification proof is incomplete or tampered.')
const controlledSource = sourceControlled.source as { checksum?: unknown }
if (
  sourceControlled.legacyLedger !== true ||
  !sourcePrivateCounts ||
  Object.values(sourcePrivateCounts).some(value => Number(value) !== 0) ||
  !sourceRepeatImport.includes('import is a no-op') ||
  classifiedExpected?.applicationSnapshotChecksum !== controlledSource?.checksum
)
  throw new Error('Controlled legacy Preview source evidence is incomplete or unsafe.')
if (JSON.stringify(first) !== JSON.stringify(repeat))
  throw new Error('First and repeat Preview parity evidence differ.')
if (
  first.siteId !== siteId ||
  first.environment !== 'preview' ||
  typeof first.checksum !== 'string'
)
  throw new Error('Preview parity output is not bound to the selected Site.')
const report = parse(readFileSync(resolve(target.parityReportPath), 'utf8')) as {
  target: { checksum: string }
}
if (first.checksum !== report.target.checksum)
  throw new Error('Preview parity checksum does not match the reviewed controlled fixture.')
if (preflight.targetInitiallyEmpty !== true && preflight.trustedPriorReceipt !== true)
  throw new Error('Preview target had neither empty state nor a trusted prior receipt.')
if (
  measured.exactParity !== true ||
  measured.freshLedger !== true ||
  repeatMeasured.exactParity !== true ||
  repeatMeasured.freshLedger !== true ||
  postJourneyMeasured.exactParity !== true ||
  postJourneyMeasured.freshLedger !== true
)
  throw new Error('Measured exact parity or fresh migration ledger evidence failed.')
const measuredSource = measured.source as { checksum?: unknown }
const measuredTarget = measured.target as { checksum?: unknown }
const repeatedTarget = repeatMeasured.target as { checksum?: unknown }
const postJourneyTarget = postJourneyMeasured.target as { checksum?: unknown }
if (
  typeof measuredSource?.checksum !== 'string' ||
  measuredSource.checksum !== measuredTarget?.checksum ||
  measuredTarget.checksum !== repeatedTarget?.checksum ||
  measuredTarget.checksum !== postJourneyTarget?.checksum
)
  throw new Error('Measured source, target, and repeated target checksums differ.')
const catalogJourneyKeys = [
  'category',
  'detail',
  'home',
  'legacyRedirect',
  'rss',
  'search',
  'sitemap',
  'submit'
] as const
const allTrue = (
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void => {
  if (
    Object.keys(record).sort().join('\0') !== [...expectedKeys].sort().join('\0') ||
    expectedKeys.some(key => record[key] !== true)
  )
    throw new Error(`${label} did not pass with the exact required journey set.`)
}
allTrue(catalog, catalogJourneyKeys, 'Catalog journeys')
for (const key of [
  'intake',
  'rateLimit',
  'badgeVerification',
  'privatePreview',
  'approval',
  'rejection',
  'sourceUnchanged'
])
  if (submission[key] !== true) throw new Error(`Submission journey ${key} did not pass.`)
if (submissionCleanup.recovered !== true)
  throw new Error('Idempotent external Submission recovery did not complete.')
const rateLimitEvidence = submission.rateLimitEvidence as Record<string, unknown>
if (
  !rateLimitEvidence ||
  rateLimitEvidence.status !== 429 ||
  typeof rateLimitEvidence.attempts !== 'number' ||
  rateLimitEvidence.attempts < 1 ||
  rateLimitEvidence.attempts > 12 ||
  typeof rateLimitEvidence.ownedFingerprint !== 'string' ||
  !rateLimitEvidence.ownedFingerprint
)
  throw new Error('Submission rate-limit evidence is not a bounded real 429 result.')
allTrue(rollbackSource, catalogJourneyKeys, 'Source rollback route gates')
allTrue(rollbackTarget, catalogJourneyKeys, 'Replacement restoration route gates')
const copiedProduction = measured.privateCounts as Record<string, unknown>
if (!copiedProduction || Object.values(copiedProduction).some(value => Number(value) !== 0))
  throw new Error('Measured copied Production private-state counts must be zero.')
const previewGenerated = submission.previewGenerated as Record<string, unknown>
if (
  !previewGenerated ||
  Object.values(previewGenerated).some(value => !Number.isInteger(value) || Number(value) < 1)
)
  throw new Error('Measured Preview-generated private-state counts are invalid.')
const afterCleanup = submission.targetPrivateRowsAfterCleanup as Record<string, unknown>
if (!afterCleanup || Object.values(afterCleanup).some(value => Number(value) !== 0))
  throw new Error('Submission journey cleanup deleted or retained unexpected state.')
let sanitization: Record<string, unknown> | undefined
if (sanitizationJournal && sanitizationResult) {
  const journalProof = sanitizationJournal.reviewedPrivateTableProof
  const resultProof = sanitizationResult.reviewedPrivateTableProof
  const mode = sanitizationResult.mode
  const sanitizedInThisRun = mode === 'sanitized' || mode === 'recovered-after-uncertain-response'
  if (
    sanitizationJournal.version !== 1 ||
    sanitizationJournal.siteId !== siteId ||
    sanitizationJournal.commitSha !== process.env.GITHUB_SHA ||
    sanitizationJournal.sourceDatabaseId !== process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID ||
    sanitizationJournal.backupSha256 !== sanitizationResult.backupSha256 ||
    sanitizationJournal.beforeChecksum !== sanitizationResult.beforeChecksum ||
    sanitizationJournal.expectedAfterChecksum !== sanitizationResult.afterChecksum ||
    JSON.stringify(journalProof) !== JSON.stringify(resultProof) ||
    !['sanitized', 'recovered-after-uncertain-response', 'already-sanitized'].includes(
      String(mode)
    ) ||
    (sanitizedInThisRun &&
      (!sanitizationJournal.submissionId ||
        !sanitizationJournal.eventId ||
        !sanitizationJournal.rateFingerprint ||
        sanitizationJournal.submissionId !== sanitizationResult.submissionId ||
        sanitizationJournal.eventId !== sanitizationResult.eventId ||
        sanitizationJournal.rateFingerprint !== sanitizationResult.rateFingerprint)) ||
    (!sanitizedInThisRun &&
      (sanitizationJournal.submissionId !== null ||
        sanitizationJournal.eventId !== null ||
        sanitizationJournal.rateFingerprint !== null))
  )
    throw new Error('PVD Preview sanitization journal/result evidence is incomplete or mismatched.')
  sanitization = {
    mode,
    backupSha256: sanitizationResult.backupSha256,
    beforeChecksum: sanitizationResult.beforeChecksum,
    afterChecksum: sanitizationResult.afterChecksum,
    sourceDatabaseId: sanitizationJournal.sourceDatabaseId,
    reviewedPrivateTableProof: resultProof,
    journalDigest: previewReceiptSha256(sanitizationJournal),
    resultDigest: previewReceiptSha256(sanitizationResult),
    deletedPrivateRows: sanitizedInThisRun ? 3 : 0,
    submissionId: sanitizationResult.submissionId,
    eventId: sanitizationResult.eventId,
    rateFingerprint: sanitizationResult.rateFingerprint
  }
}
const artifactFiles = readdirSync(resolve(target.artifactBatchDirectory))
  .filter(file => file.endsWith('.sql'))
  .sort()
const finalSnapshotSha256 = createHash('sha256')
  .update(
    artifactFiles
      .map(file => `${file}\0${readFileSync(resolve(target.artifactBatchDirectory, file), 'utf8')}`)
      .join('\0')
  )
  .digest('hex')
const evidence = {
  siteId,
  environment: 'preview',
  commitSha: process.env.GITHUB_SHA,
  migrationChecksum: freshMigrationChecksum(),
  initialWorkerDeployment,
  secretWorkerDeployment,
  identity: { ...identity, attestation: workerAttestation },
  legacySource: {
    initialClassification: sourceClassification.classification,
    checksum: controlledSource.checksum,
    classificationArtifact: sourceFinalClassification,
    classificationDigest: previewReceiptSha256(sourceFinalClassification),
    migrationNames: finalMigrationNames,
    normalizedSchemaFingerprint: finalObserved.schemaFingerprint,
    observedSiteIds: finalSiteIds,
    unexpectedUserObjects: finalUnexpectedObjects,
    ledgerVerified: sourceControlled.legacyLedger,
    privateCounts: sourcePrivateCounts,
    repeatImportMode: 'verified-no-op'
  },
  migration: {
    finalSnapshotSha256,
    sourceSnapshotChecksum: measuredSource.checksum,
    targetSnapshotChecksum: measuredTarget.checksum,
    firstRunMode: firstImport.includes('import is a no-op') ? 'verified-no-op' : 'imported',
    repeatRunMode: 'verified-no-op',
    exactParity: measured.exactParity,
    freshMigrationLedger: measured.freshLedger
  },
  catalogJourneys: [
    'home',
    'category',
    'detail',
    'search',
    'rss',
    'sitemap',
    'legacy-redirect',
    'submit'
  ],
  submissionJourneys: [
    'intake',
    'rate-limit',
    'badge-verification',
    'private-review-preview',
    'approval',
    'rejection'
  ],
  rollbackRehearsed:
    Object.values(rollbackSource).every(value => value === true) &&
    Object.values(rollbackTarget).every(value => value === true),
  nothingDeleted:
    submission.sourceUnchanged === true &&
    Object.values(afterCleanup).every(value => Number(value) === 0),
  previewData: {
    policy: previewDataPolicy,
    copiedProduction,
    previewGenerated,
    ...(sanitization ? { sanitization } : {})
  }
}
writeFileSync(resolve(required(values, '--output')), `${JSON.stringify(evidence, null, 2)}\n`)
