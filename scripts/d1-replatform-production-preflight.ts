import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  freshMigrationChecksum,
  previewReceiptSha256,
  validateCutoverEvidence
} from './d1-replatform-cutover'
import { parseSiteId, resolveSiteTarget, type SiteId } from './site-targets'

const repository = 'serpcompany/directory-platform-d1'
const previewWorkflowPath = '.github/workflows/rehearse-d1-replatform-preview.yml'
const mainRef = 'refs/heads/main'
const maxJsonBytes = 2 * 1024 * 1024
const maxArtifactBytes = 128 * 1024 * 1024
const maxReceiptBytes = 2 * 1024 * 1024
const maxZipEntries = 5_000

type JsonObject = Record<string, unknown>

export interface PreviewArtifactRequest {
  checkedOutHeadSha: string
  expectedReceiptSha256: string
  repository: string
  runId: number
  siteId: string
}

export interface PreviewArtifactDependencies {
  downloadArtifact(archiveUrl: string): Promise<Uint8Array>
  fetchArtifactList(runId: number, artifactName: string): Promise<unknown>
  fetchWorkflowRun(runId: number): Promise<unknown>
  readGit(command: 'head' | 'status'): string
}

export interface TrustedPreviewReceipt {
  artifactId: number
  artifactName: string
  receipt: { evidence: JsonObject; sha256: string }
  runId: number
  siteId: SiteId
}

export interface ProductionIdentityRequest {
  accountId: string
  allowedSiteIds: string[]
  checkedOutHeadSha: string
  eventName: string
  expectedAccountId: string
  githubRef: string
  githubSha: string
  protectedEnvironment: string
  repository: string
  replacementDatabaseId: string
  replacementDatabaseName: string
  sourceDatabaseId: string
  sourceDatabaseName: string
  siteId: string
  workerName: string
}

export interface ProductionIdentityDependencies {
  fetchAccount(accountId: string): Promise<unknown>
  fetchDatabase(accountId: string, databaseId: string): Promise<unknown>
  fetchDeployments(accountId: string, workerName: string): Promise<unknown>
  fetchRoutes(zoneId: string): Promise<unknown>
  fetchWorker(accountId: string, workerName: string): Promise<unknown>
  fetchWorkerVersion(accountId: string, workerName: string, versionId: string): Promise<unknown>
  fetchZones(accountId: string, zoneName: string): Promise<unknown>
  readGit(command: 'head' | 'status'): string
}

export interface ProductionIdentityProof {
  activeDeploymentId: string
  activeVersionId: string
  accountId: string
  allowedSiteIds: [SiteId]
  currentDatabaseId: string
  protectedEnvironment: string
  replacementDatabaseId: string
  replacementDatabaseName: string
  routeId: string
  routePattern: string
  siteId: SiteId
  sourceDatabaseId: string
  sourceDatabaseName: string
  verifiedAt: string
  workerName: string
  zoneId: string
  zoneName: string
}

function fail(rule: string, remediation: string): never {
  throw new Error(
    `${rule} Why this matters: untrusted Preview evidence or Production identity must never authorize a cutover. Remediation: ${remediation} Documentation: docs/D1_CUTOVER.md.`
  )
}

function guardedBoundary<T>(operation: () => T, rule: string, remediation: string): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof Error && error.message.includes('Documentation: docs/D1_CUTOVER.md.')) {
      throw error
    }
    const detail = error instanceof Error ? error.message : String(error)
    fail(`${rule} Provider detail: ${detail}`, remediation)
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      `${label} must be an object.`,
      'Inspect the provider response and retry without weakening parsing.'
    )
  }
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${label} must be nonempty text.`, 'Correct the protected value or provider response.')
  }
  return value
}

function sha256(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!/^[0-9a-f]{64}$/u.test(parsed)) {
    fail(`${label} must be a lowercase SHA-256.`, 'Copy the complete reviewed digest exactly.')
  }
  return parsed
}

function commitSha(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!/^[0-9a-f]{40}$/u.test(parsed)) {
    fail(`${label} must be a full lowercase commit SHA.`, 'Use the exact checked-out main commit.')
  }
  return parsed
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail(
      `${label} must be a positive safe integer.`,
      'Use the exact numeric GitHub run or artifact ID.'
    )
  }
  return value
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.join('\0') !== wanted.join('\0')) {
    fail(
      `${label} has unexpected or missing fields.`,
      'Use the complete sealed receipt without editing it.'
    )
  }
}

function envelopeResult(value: unknown, label: string): unknown {
  const envelope = object(value, label)
  if (envelope.success !== true) {
    fail(
      `${label} was not successful.`,
      'Verify the read-only credential and provider status, then retry.'
    )
  }
  return envelope.result
}

function assertRepository(value: unknown, label: string): void {
  if (text(value, label) !== repository) {
    fail(
      `${label} is not ${repository}.`,
      'Dispatch and consume evidence only in the registered repository.'
    )
  }
}

function assertExactSiteSet(value: unknown, siteId: SiteId, label: string): void {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== siteId) {
    fail(
      `${label} must contain only ${siteId}.`,
      'Set the protected allowed Site list to the selected Site only.'
    )
  }
}

function artifactName(siteId: SiteId, sha: string): string {
  return `${siteId}-d1-replatform-preview-evidence-${sha}`
}

function bytesSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function u16(source: Uint8Array, offset: number): number {
  return source[offset]! | (source[offset + 1]! << 8)
}

function u32(source: Uint8Array, offset: number): number {
  return (u16(source, offset) | (u16(source, offset + 2) << 16)) >>> 0
}

function zipReceipt(archive: Uint8Array): string {
  if (archive.byteLength < 22 || archive.byteLength > maxArtifactBytes) {
    fail(
      'Preview artifact ZIP size is outside the bounded limit.',
      'Retain only the reviewed evidence package and rerun Preview.'
    )
  }
  let end = -1
  const minimum = Math.max(0, archive.byteLength - 65_557)
  for (let index = archive.byteLength - 22; index >= minimum; index -= 1) {
    if (u32(archive, index) === 0x06054b50) {
      end = index
      break
    }
  }
  if (end < 0 || u16(archive, end + 4) !== 0 || u16(archive, end + 6) !== 0) {
    fail(
      'Preview artifact is not a single-disk ZIP.',
      'Download the original GitHub Actions artifact again.'
    )
  }
  const entries = u16(archive, end + 10)
  const centralSize = u32(archive, end + 12)
  const centralOffset = u32(archive, end + 16)
  const commentLength = u16(archive, end + 20)
  if (
    entries < 1 ||
    entries > maxZipEntries ||
    u16(archive, end + 8) !== entries ||
    end + 22 + commentLength !== archive.byteLength ||
    centralOffset + centralSize !== end
  ) {
    fail(
      'Preview artifact ZIP directory is malformed or exceeds bounds.',
      'Regenerate the GitHub Actions artifact.'
    )
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = centralOffset
  const matches: Array<{
    compressedSize: number
    compression: number
    localOffset: number
    name: string
    uncompressedSize: number
  }> = []
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || u32(archive, offset) !== 0x02014b50) {
      fail(
        'Preview artifact ZIP central directory is malformed.',
        'Regenerate the GitHub Actions artifact.'
      )
    }
    const flags = u16(archive, offset + 8)
    const compression = u16(archive, offset + 10)
    const compressedSize = u32(archive, offset + 20)
    const uncompressedSize = u32(archive, offset + 24)
    const nameLength = u16(archive, offset + 28)
    const extraLength = u16(archive, offset + 30)
    const entryCommentLength = u16(archive, offset + 32)
    const localOffset = u32(archive, offset + 42)
    const next = offset + 46 + nameLength + extraLength + entryCommentLength
    if (
      next > end ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(compression) ||
      [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)
    ) {
      fail(
        'Preview artifact ZIP entry is unsupported or unsafe.',
        'Upload an unencrypted non-ZIP64 GitHub Actions artifact.'
      )
    }
    let name: string
    try {
      name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    } catch {
      fail(
        'Preview artifact ZIP entry name is not UTF-8.',
        'Regenerate the GitHub Actions artifact.'
      )
    }
    if (
      !name ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.split('/').some(part => part === '..' || part === '.')
    ) {
      fail(
        'Preview artifact ZIP contains an unsafe path.',
        'Regenerate the GitHub Actions artifact without traversal paths.'
      )
    }
    if (
      name === 'd1-replatform-evidence/preview-receipt.json' ||
      name.endsWith('/d1-replatform-evidence/preview-receipt.json')
    ) {
      matches.push({ compressedSize, compression, localOffset, name, uncompressedSize })
    }
    offset = next
  }
  if (offset !== end || matches.length !== 1) {
    fail(
      'Preview artifact must contain exactly one sealed preview-receipt.json.',
      'Use the named artifact from the successful protected Preview run.'
    )
  }
  const entry = matches[0]!
  if (
    entry.uncompressedSize > maxReceiptBytes ||
    entry.localOffset + 30 > centralOffset ||
    u32(archive, entry.localOffset) !== 0x04034b50
  ) {
    fail(
      'Preview receipt ZIP entry is malformed or exceeds bounds.',
      'Regenerate the protected Preview artifact.'
    )
  }
  const localFlags = u16(archive, entry.localOffset + 6)
  const localCompression = u16(archive, entry.localOffset + 8)
  const localNameLength = u16(archive, entry.localOffset + 26)
  const localExtraLength = u16(archive, entry.localOffset + 28)
  const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength
  const dataEnd = dataOffset + entry.compressedSize
  if ((localFlags & 1) !== 0 || localCompression !== entry.compression || dataEnd > centralOffset) {
    fail(
      'Preview receipt local ZIP entry does not match its directory.',
      'Regenerate the protected Preview artifact.'
    )
  }
  let localName: string
  try {
    localName = decoder.decode(
      archive.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength)
    )
  } catch {
    fail(
      'Preview receipt local ZIP name is not UTF-8.',
      'Regenerate the protected Preview artifact.'
    )
  }
  if (localName !== entry.name) {
    fail('Preview receipt ZIP entry names disagree.', 'Regenerate the protected Preview artifact.')
  }
  const compressed = archive.subarray(dataOffset, dataEnd)
  let receipt: Uint8Array
  try {
    receipt =
      entry.compression === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: maxReceiptBytes })
  } catch {
    fail(
      'Preview receipt ZIP entry cannot be decompressed safely.',
      'Regenerate the protected Preview artifact.'
    )
  }
  if (receipt.byteLength !== entry.uncompressedSize || receipt.byteLength > maxReceiptBytes) {
    fail(
      'Preview receipt ZIP size does not match its directory.',
      'Regenerate the protected Preview artifact.'
    )
  }
  try {
    return decoder.decode(receipt)
  } catch {
    fail('Preview receipt is not UTF-8.', 'Regenerate the protected Preview artifact.')
  }
}

export async function downloadTrustedPreviewReceipt(
  rawRequest: PreviewArtifactRequest,
  dependencies: PreviewArtifactDependencies
): Promise<TrustedPreviewReceipt> {
  const request = object(rawRequest, 'Preview artifact request')
  exactKeys(
    request,
    ['checkedOutHeadSha', 'expectedReceiptSha256', 'repository', 'runId', 'siteId'],
    'Preview artifact request'
  )
  const siteId = guardedBoundary(
    () => parseSiteId(text(request.siteId, 'siteId')),
    'Preview artifact Site selection is invalid.',
    'Select exactly one registered Site and rerun the same artifact check.'
  )
  assertRepository(request.repository, 'repository')
  const headSha = commitSha(request.checkedOutHeadSha, 'checkedOutHeadSha')
  if (dependencies.readGit('status') || dependencies.readGit('head') !== headSha) {
    fail(
      'Preview trust requires a clean checkout whose HEAD equals the requested commit.',
      'Check out the exact reviewed main commit in a clean runner before consuming evidence.'
    )
  }
  const expectedDigest = sha256(request.expectedReceiptSha256, 'expectedReceiptSha256')
  const runId = safeInteger(request.runId, 'runId')
  const run = object(await dependencies.fetchWorkflowRun(runId), 'GitHub workflow run')
  const runRepository = object(run.repository, 'GitHub workflow run.repository')
  assertRepository(runRepository.full_name, 'GitHub workflow run repository')
  const repositoryId = safeInteger(runRepository.id, 'GitHub workflow run repository.id')
  if (
    safeInteger(run.id, 'GitHub workflow run.id') !== runId ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    commitSha(run.head_sha, 'GitHub workflow run.head_sha') !== headSha ||
    run.path !== previewWorkflowPath
  ) {
    fail(
      'GitHub run is not the exact successful main Preview workflow for checked-out HEAD.',
      'Dispatch the protected Preview workflow from this exact main commit and use that successful run ID.'
    )
  }
  const expectedName = artifactName(siteId, headSha)
  const list = object(
    await dependencies.fetchArtifactList(runId, expectedName),
    'GitHub artifact list'
  )
  const totalCount = safeInteger(list.total_count, 'GitHub artifact list.total_count')
  if (!Array.isArray(list.artifacts) || list.artifacts.length !== 1 || totalCount !== 1) {
    fail(
      'GitHub returned an absent or ambiguous named Preview artifact.',
      'Use the sole retained evidence artifact from the requested run.'
    )
  }
  const artifact = object(list.artifacts[0], 'GitHub artifact')
  const workflowRun = object(artifact.workflow_run, 'GitHub artifact.workflow_run')
  if (
    text(artifact.name, 'GitHub artifact.name') !== expectedName ||
    artifact.expired !== false ||
    safeInteger(workflowRun.id, 'GitHub artifact.workflow_run.id') !== runId ||
    safeInteger(workflowRun.repository_id, 'GitHub artifact.workflow_run.repository_id') !==
      repositoryId ||
    safeInteger(
      workflowRun.head_repository_id,
      'GitHub artifact.workflow_run.head_repository_id'
    ) !== repositoryId ||
    workflowRun.head_branch !== 'main' ||
    commitSha(workflowRun.head_sha, 'GitHub artifact.workflow_run.head_sha') !== headSha
  ) {
    fail(
      'GitHub artifact metadata is not bound to the requested successful run.',
      'Select the unexpired exact-name artifact emitted by that run.'
    )
  }
  const archiveUrl = text(artifact.archive_download_url, 'GitHub artifact.archive_download_url')
  const expectedArchiveUrl = `https://api.github.com/repos/${repository}/actions/artifacts/${safeInteger(artifact.id, 'GitHub artifact.id')}/zip`
  if (archiveUrl !== expectedArchiveUrl) {
    fail(
      'GitHub artifact download URL is unexpected.',
      'Fetch the artifact only through its canonical repository API URL.'
    )
  }
  const artifactDigest = text(artifact.digest, 'GitHub artifact.digest')
  if (
    !artifactDigest.startsWith('sha256:') ||
    sha256(artifactDigest.slice(7), 'GitHub artifact digest') !== artifactDigest.slice(7)
  ) {
    fail('GitHub artifact digest is malformed.', 'Regenerate the protected Preview artifact.')
  }
  const archive = await dependencies.downloadArtifact(archiveUrl)
  const declaredArtifactSize = safeInteger(artifact.size_in_bytes, 'GitHub artifact.size_in_bytes')
  if (
    declaredArtifactSize > maxArtifactBytes ||
    archive.byteLength > maxArtifactBytes ||
    bytesSha256(archive) !== artifactDigest.slice(7)
  ) {
    fail(
      'Downloaded Preview artifact does not match GitHub metadata.',
      'Download the original artifact again; do not use a local copy.'
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(zipReceipt(archive))
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail('Preview receipt is not valid JSON.', 'Regenerate the protected Preview artifact.')
    }
    throw error
  }
  const receipt = object(parsed, 'Preview receipt')
  exactKeys(receipt, ['evidence', 'sha256'], 'Preview receipt')
  const evidence = object(receipt.evidence, 'Preview receipt.evidence')
  const embeddedDigest = sha256(receipt.sha256, 'Preview receipt.sha256')
  if (embeddedDigest !== expectedDigest || previewReceiptSha256(evidence) !== embeddedDigest) {
    fail(
      'Preview receipt digest does not match both embedded and protected trust.',
      'Set the protected digest from the reviewed sealed receipt, then rerun without editing the artifact.'
    )
  }
  guardedBoundary(
    () => validateCutoverEvidence(evidence, { commitSha: headSha }),
    'Full sealed Preview receipt validation failed.',
    'Rerun the protected Preview workflow from this exact main commit; do not edit or partially trust the receipt.'
  )
  const migrationChecksum = guardedBoundary(
    () => freshMigrationChecksum(),
    'The checked-out fresh migration history cannot be verified.',
    'Restore the reviewed d1/drizzle history and rerun from a clean exact-main checkout.'
  )
  if (
    evidence.siteId !== siteId ||
    evidence.environment !== 'preview' ||
    evidence.commitSha !== headSha ||
    evidence.migrationChecksum !== migrationChecksum
  ) {
    fail(
      'Preview receipt does not match this Site, commit, or fresh migration history.',
      'Rerun Preview from the exact checked-out main commit for this Site.'
    )
  }
  return {
    artifactId: safeInteger(artifact.id, 'GitHub artifact.id'),
    artifactName: expectedName,
    receipt: { evidence, sha256: embeddedDigest },
    runId,
    siteId
  }
}

function parseDatabase(value: unknown, label: string): { name: string; uuid: string } {
  const result = object(envelopeResult(value, label), `${label}.result`)
  return {
    name: text(result.name, `${label}.result.name`),
    uuid: text(result.uuid, `${label}.result.uuid`)
  }
}

export async function verifyProductionIdentityPreflight(
  rawRequest: ProductionIdentityRequest,
  dependencies: ProductionIdentityDependencies,
  now: () => string = () => new Date().toISOString()
): Promise<ProductionIdentityProof> {
  const request = object(rawRequest, 'Production identity request')
  exactKeys(
    request,
    [
      'accountId',
      'allowedSiteIds',
      'checkedOutHeadSha',
      'eventName',
      'expectedAccountId',
      'githubRef',
      'githubSha',
      'protectedEnvironment',
      'repository',
      'replacementDatabaseId',
      'replacementDatabaseName',
      'sourceDatabaseId',
      'sourceDatabaseName',
      'siteId',
      'workerName'
    ],
    'Production identity request'
  )
  const siteId = guardedBoundary(
    () => parseSiteId(text(request.siteId, 'siteId')),
    'Production preflight Site selection is invalid.',
    'Select exactly one registered Site in the protected workflow.'
  )
  const target = guardedBoundary(
    () => resolveSiteTarget(siteId),
    'Production Site registry lookup failed.',
    'Restore the reviewed Site registry and rerun from a clean exact-main checkout.'
  )
  assertRepository(request.repository, 'repository')
  const headSha = commitSha(request.checkedOutHeadSha, 'checkedOutHeadSha')
  if (dependencies.readGit('status') || dependencies.readGit('head') !== headSha) {
    fail(
      'Production preflight requires a clean checkout whose HEAD equals the requested commit.',
      'Check out the exact reviewed main commit in a clean runner before reading Production identity.'
    )
  }
  if (
    request.eventName !== 'workflow_dispatch' ||
    request.githubRef !== mainRef ||
    commitSha(request.githubSha, 'githubSha') !== headSha
  ) {
    fail(
      'Production preflight requires workflow_dispatch from exact checked-out main HEAD.',
      'Dispatch a future protected cutover workflow from the exact reviewed main commit.'
    )
  }
  if (request.protectedEnvironment !== target.protectedEnvironment.production) {
    fail(
      'Protected Production environment does not match the Site registry.',
      'Select the registered Site-specific Production environment.'
    )
  }
  assertExactSiteSet(request.allowedSiteIds, siteId, 'allowedSiteIds')
  const accountId = text(request.accountId, 'accountId')
  const expectedAccountId = text(request.expectedAccountId, 'expectedAccountId')
  if (accountId !== expectedAccountId) {
    fail(
      'Configured Cloudflare account IDs differ.',
      'Correct the protected account pair before retrying.'
    )
  }
  const account = object(
    envelopeResult(await dependencies.fetchAccount(accountId), 'Cloudflare account'),
    'Cloudflare account.result'
  )
  if (text(account.id, 'Cloudflare account.result.id') !== expectedAccountId) {
    fail(
      'Observed Cloudflare account differs from protected identity.',
      'Use a read-only credential for the registered account.'
    )
  }
  const sourceId = text(request.sourceDatabaseId, 'sourceDatabaseId')
  const sourceName = text(request.sourceDatabaseName, 'sourceDatabaseName')
  const replacementId = text(request.replacementDatabaseId, 'replacementDatabaseId')
  const replacementName = text(request.replacementDatabaseName, 'replacementDatabaseName')
  if (sourceId === replacementId || sourceName === replacementName) {
    fail(
      'Production source and replacement D1 identities must be distinct.',
      'Provision and register a separate replacement database.'
    )
  }
  const [source, replacement] = await Promise.all([
    dependencies
      .fetchDatabase(accountId, sourceId)
      .then(value => parseDatabase(value, 'Production source D1')),
    dependencies
      .fetchDatabase(accountId, replacementId)
      .then(value => parseDatabase(value, 'Production replacement D1'))
  ])
  if (
    source.uuid !== sourceId ||
    source.name !== sourceName ||
    replacement.uuid !== replacementId ||
    replacement.name !== replacementName
  ) {
    fail(
      'Observed Production D1 identity differs from protected values.',
      'Reconcile the exact UUID/name pairs in the protected environment.'
    )
  }
  const workerName = text(request.workerName, 'workerName')
  const worker = object(
    envelopeResult(
      await dependencies.fetchWorker(accountId, workerName),
      'Cloudflare Worker service'
    ),
    'Cloudflare Worker service.result'
  )
  if (text(worker.name ?? worker.id, 'Cloudflare Worker service name') !== workerName) {
    fail(
      'Observed Production Worker service differs from protected identity.',
      'Select the existing registered Production Worker service.'
    )
  }
  const zones = envelopeResult(
    await dependencies.fetchZones(accountId, siteId),
    'Cloudflare zone list'
  )
  if (!Array.isArray(zones) || zones.length !== 1) {
    fail(
      'Cloudflare zone identity is missing or ambiguous.',
      'Ensure the credential sees exactly the registered apex zone.'
    )
  }
  const zone = object(zones[0], 'Cloudflare zone')
  const zoneAccount = object(zone.account, 'Cloudflare zone.account')
  const zoneId = text(zone.id, 'Cloudflare zone.id')
  if (zone.name !== siteId || zone.status !== 'active' || zoneAccount.id !== accountId) {
    fail(
      'Observed Cloudflare zone does not match the active Site apex and account.',
      'Correct DNS zone ownership before any cutover.'
    )
  }
  const routes = envelopeResult(await dependencies.fetchRoutes(zoneId), 'Cloudflare route list')
  if (!Array.isArray(routes) || routes.length > 10_000) {
    fail(
      'Cloudflare route list is malformed or exceeds bounds.',
      'Inspect the zone route inventory manually.'
    )
  }
  const expectedPattern = `${siteId}/*`
  const matchingRoutes = routes
    .map((value, index) => object(value, `Cloudflare route[${index}]`))
    .filter(route => route.pattern === expectedPattern)
  if (matchingRoutes.length !== 1 || matchingRoutes[0]?.script !== workerName) {
    fail(
      'Production apex route is absent, ambiguous, or bound to another Worker.',
      'Bind the sole exact apex route to the registered Production Worker before retrying.'
    )
  }
  const routeId = text(matchingRoutes[0].id, 'Cloudflare apex route.id')
  const deploymentResult = object(
    envelopeResult(
      await dependencies.fetchDeployments(accountId, workerName),
      'Cloudflare Worker deployments'
    ),
    'Cloudflare Worker deployments.result'
  )
  if (
    !Array.isArray(deploymentResult.deployments) ||
    deploymentResult.deployments.length < 1 ||
    deploymentResult.deployments.length > 100
  ) {
    fail(
      'Cloudflare Worker deployment history is missing or exceeds bounds.',
      'Inspect the registered Worker deployment history.'
    )
  }
  const activeDeployment = object(deploymentResult.deployments[0], 'Active Worker deployment')
  if (!Array.isArray(activeDeployment.versions) || activeDeployment.versions.length !== 1) {
    fail(
      'Active Production deployment must contain one version.',
      'Finish or roll back any gradual deployment before cutover.'
    )
  }
  const activeVersion = object(activeDeployment.versions[0], 'Active Worker deployment version')
  if (activeVersion.percentage !== 100) {
    fail(
      'Active Production version must receive 100 percent of traffic.',
      'Finish or roll back any gradual deployment before cutover.'
    )
  }
  const versionId = text(activeVersion.version_id, 'Active Worker version ID')
  const version = object(
    envelopeResult(
      await dependencies.fetchWorkerVersion(accountId, workerName, versionId),
      'Cloudflare Worker version'
    ),
    'Cloudflare Worker version.result'
  )
  if (version.id !== versionId) {
    fail(
      'Observed Worker version differs from the active deployment.',
      'Retry read-only preflight after deployment state stabilizes.'
    )
  }
  const resources = object(version.resources, 'Cloudflare Worker version.resources')
  if (!Array.isArray(resources.bindings) || resources.bindings.length > 1_000) {
    fail(
      'Worker version bindings are missing or exceed bounds.',
      'Inspect the active Worker version configuration.'
    )
  }
  const dbBindings = resources.bindings
    .map((value, index) => object(value, `Worker binding[${index}]`))
    .filter(binding => binding.type === 'd1' && binding.name === 'DB')
  if (dbBindings.length !== 1) {
    fail(
      'Active Worker version must have exactly one DB D1 binding.',
      'Restore the reviewed single Production DB binding.'
    )
  }
  const currentDatabaseId = text(
    dbBindings[0]?.database_id ?? dbBindings[0]?.id,
    'Active Worker DB database_id'
  )
  if (currentDatabaseId !== sourceId) {
    fail(
      'Active Production Worker is not bound to the protected source D1.',
      'Stop: reconcile or roll back the Worker binding before beginning cutover.'
    )
  }
  return {
    activeDeploymentId: text(activeDeployment.id, 'Active Worker deployment.id'),
    activeVersionId: versionId,
    accountId,
    allowedSiteIds: [siteId],
    currentDatabaseId,
    protectedEnvironment: target.protectedEnvironment.production,
    replacementDatabaseId: replacementId,
    replacementDatabaseName: replacementName,
    routeId,
    routePattern: expectedPattern,
    siteId,
    sourceDatabaseId: sourceId,
    sourceDatabaseName: sourceName,
    verifiedAt: now(),
    workerName,
    zoneId,
    zoneName: siteId
  }
}

async function boundedResponse(
  response: Response,
  limit: number,
  label: string
): Promise<Uint8Array> {
  if (!response.ok)
    fail(
      `${label} failed with HTTP ${response.status}.`,
      'Verify read-only credentials and provider status, then retry.'
    )
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    fail(
      `${label} exceeds the bounded response size.`,
      'Reduce the evidence package or inspect the provider response.'
    )
  }
  if (!response.body) fail(`${label} returned no body.`, 'Retry the provider request.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      fail(
        `${label} exceeds the bounded response size.`,
        'Reduce the evidence package or inspect the provider response.'
      )
    }
    chunks.push(value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function boundedJson(response: Response, label: string): Promise<unknown> {
  const bytes = await boundedResponse(response, maxJsonBytes, label)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail(`${label} is not bounded UTF-8 JSON.`, 'Inspect the provider response and retry.')
  }
}

async function providerFetch(
  input: string | URL,
  init: RequestInit,
  label: string
): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch {
    fail(
      `${label} request failed or exceeded its time bound.`,
      'Verify network access and provider status, then retry the same read-only preflight.'
    )
  }
}

function authHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

function readGit(command: 'head' | 'status'): string {
  const args = command === 'head' ? ['rev-parse', 'HEAD'] : ['status', '--porcelain']
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(
      'Unable to inspect the checked-out Git identity.',
      'Run preflight from a valid clean checkout of the registered repository.'
    )
  }
  return result.stdout.trim()
}

export function githubPreviewArtifactDependencies(token: string): PreviewArtifactDependencies {
  text(token, 'GitHub token')
  const requestOptions = (headers: HeadersInit): RequestInit => ({
    headers,
    signal: AbortSignal.timeout(15_000)
  })
  return {
    async fetchWorkflowRun(runId) {
      return boundedJson(
        await providerFetch(
          `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
          requestOptions(authHeaders(token)),
          'GitHub workflow run'
        ),
        'GitHub workflow run'
      )
    },
    async fetchArtifactList(runId, name) {
      const url = new URL(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`
      )
      url.searchParams.set('name', name)
      url.searchParams.set('per_page', '100')
      url.searchParams.set('page', '1')
      return boundedJson(
        await providerFetch(url, requestOptions(authHeaders(token)), 'GitHub artifact list'),
        'GitHub artifact list'
      )
    },
    async downloadArtifact(archiveUrl) {
      return boundedResponse(
        await providerFetch(
          archiveUrl,
          { ...requestOptions(authHeaders(token)), redirect: 'follow' },
          'GitHub artifact download'
        ),
        maxArtifactBytes,
        'GitHub artifact download'
      )
    },
    readGit
  }
}

function cloudflareHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

export function cloudflareProductionIdentityDependencies(
  token: string
): ProductionIdentityDependencies {
  text(token, 'Cloudflare token')
  const get = async (path: string, label: string): Promise<unknown> =>
    boundedJson(
      await providerFetch(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          headers: cloudflareHeaders(token),
          signal: AbortSignal.timeout(15_000)
        },
        label
      ),
      label
    )
  return {
    fetchAccount: accountId =>
      get(`/accounts/${encodeURIComponent(accountId)}`, 'Cloudflare account'),
    fetchDatabase: (accountId, databaseId) =>
      get(
        `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`,
        'Cloudflare D1'
      ),
    fetchDeployments: (accountId, workerName) =>
      get(
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
        'Cloudflare deployments'
      ),
    fetchRoutes: zoneId =>
      get(`/zones/${encodeURIComponent(zoneId)}/workers/routes`, 'Cloudflare routes'),
    fetchWorker: (accountId, workerName) =>
      get(
        `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(workerName)}`,
        'Cloudflare Worker'
      ),
    fetchWorkerVersion: (accountId, workerName, versionId) =>
      get(
        `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}`,
        'Cloudflare Worker version'
      ),
    fetchZones: (accountId, zoneName) =>
      get(
        `/zones?account.id=${encodeURIComponent(accountId)}&name=${encodeURIComponent(zoneName)}&per_page=50&page=1`,
        'Cloudflare zones'
      ),
    readGit
  }
}
