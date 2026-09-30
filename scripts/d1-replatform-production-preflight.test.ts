import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  freshMigrationChecksum,
  previewReceiptSha256,
  previewRehearsalSecretNames
} from './d1-replatform-cutover'
import { canonicalLegacyMigrationNames } from './d1-replatform-inventory'
import {
  downloadTrustedPreviewReceipt,
  type PreviewArtifactDependencies,
  type PreviewArtifactRequest,
  type ProductionIdentityDependencies,
  type ProductionIdentityRequest,
  verifyProductionIdentityPreflight
} from './d1-replatform-production-preflight'
import { siteTargets } from './site-targets'

const headSha = 'a'.repeat(40)
const siteId = 'serp.software' as const
const runId = 42

function previewEvidence() {
  const identity = {
    siteId,
    environment: 'preview',
    protectedEnvironment: siteTargets[siteId].protectedEnvironment.preview,
    allowedSiteIds: [siteId],
    accountId: 'account-id',
    sourceDatabaseId: 'source-uuid',
    sourceDatabaseName: 'source-name',
    targetDatabaseId: 'target-uuid',
    targetDatabaseName: 'target-name',
    workerName: 'worker-name',
    workerHostname: 'preview.example.test'
  }
  const attestation = {
    bindingNonce: 'binding-nonce',
    commit: headSha,
    environment: 'preview',
    hostname: 'preview.example.test',
    run: 'run-1',
    service: 'worker-name',
    siteId
  }
  const classificationArtifact = {
    classification: 'controlled-populated',
    expected: {
      applicationSnapshotChecksum: 'e'.repeat(64),
      migrationNames: [...canonicalLegacyMigrationNames],
      schemaFingerprint: 'f'.repeat(64),
      siteId
    },
    observed: {
      applicationSnapshot: {
        checksum: 'e'.repeat(64),
        migrationNames: [...canonicalLegacyMigrationNames],
        tables: {}
      },
      hasMigrationLedger: true,
      migrationNames: [...canonicalLegacyMigrationNames],
      schemaFingerprint: 'f'.repeat(64),
      siteIds: [siteId],
      unexpectedUserObjects: []
    }
  }
  return {
    siteId,
    environment: 'preview',
    commitSha: headSha,
    migrationChecksum: freshMigrationChecksum(),
    initialWorkerDeployment: {
      absentSecretNames: [...previewRehearsalSecretNames],
      captureSource: 'wrangler-deploy-output',
      capturedVersionId: 'version-id',
      commitSha: headSha,
      credentialFree: true,
      deploymentId: 'deployment-id',
      generation: 'legacy',
      hostname: 'preview.example.test',
      scriptEtag: 'etag',
      serviceName: 'worker-name',
      siteId,
      sourceDatabaseId: 'source-uuid',
      trafficPercentage: 100,
      versionId: 'version-id'
    },
    secretWorkerDeployment: {
      commitSha: headSha,
      deploymentId: 'secret-deployment-id',
      generation: 'legacy',
      hostname: 'preview.example.test',
      previousDeploymentId: 'deployment-id',
      previousVersionId: 'version-id',
      scriptEtag: 'etag',
      secretNames: [...previewRehearsalSecretNames],
      serviceName: 'worker-name',
      siteId,
      sourceDatabaseId: 'source-uuid',
      trafficPercentage: 100,
      transitionSource: 'wrangler-secret-bulk',
      versionId: 'secret-version-id'
    },
    legacySource: {
      initialClassification: 'blank',
      checksum: 'e'.repeat(64),
      classificationArtifact,
      classificationDigest: previewReceiptSha256(classificationArtifact),
      migrationNames: [...canonicalLegacyMigrationNames],
      normalizedSchemaFingerprint: 'f'.repeat(64),
      observedSiteIds: [siteId],
      unexpectedUserObjects: [],
      ledgerVerified: true,
      privateCounts: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
      repeatImportMode: 'verified-no-op'
    },
    identity: {
      expected: identity,
      observed: { ...identity },
      attestation: { expected: attestation, observed: { ...attestation } }
    },
    migration: {
      finalSnapshotSha256: 'b'.repeat(64),
      sourceSnapshotChecksum: 'c'.repeat(64),
      targetSnapshotChecksum: 'c'.repeat(64),
      firstRunMode: 'imported',
      repeatRunMode: 'verified-no-op',
      exactParity: true,
      freshMigrationLedger: true
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
    rollbackRehearsed: true,
    nothingDeleted: true,
    previewData: {
      policy: 'controlled-fixtures',
      copiedProduction: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
      previewGenerated: { capabilityRows: 1, notificationSecretRows: 1, rateLimitRows: 1 }
    }
  }
}

function storedZip(path: string, text: string): Uint8Array {
  const name = Buffer.from(path)
  const body = Buffer.from(text)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(body.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + body.length, 16)
  return Buffer.concat([local, name, body, central, name, end])
}

function artifactFixture() {
  const evidence = previewEvidence()
  const receipt = { evidence, sha256: previewReceiptSha256(evidence) }
  const archive = storedZip('d1-replatform-evidence/preview-receipt.json', JSON.stringify(receipt))
  const artifactId = 99
  const name = `${siteId}-d1-replatform-preview-evidence-${headSha}`
  const run = {
    id: runId,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: headSha,
    path: '.github/workflows/rehearse-d1-replatform-preview.yml',
    repository: { id: 123, full_name: 'serpcompany/directory-platform-d1' }
  }
  const artifact = {
    id: artifactId,
    name,
    expired: false,
    size_in_bytes: archive.byteLength,
    digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    archive_download_url: `https://api.github.com/repos/serpcompany/directory-platform-d1/actions/artifacts/${artifactId}/zip`,
    workflow_run: {
      id: runId,
      repository_id: 123,
      head_repository_id: 123,
      head_branch: 'main',
      head_sha: headSha
    }
  }
  const dependencies: PreviewArtifactDependencies = {
    fetchWorkflowRun: async () => run,
    fetchArtifactList: async () => ({ total_count: 1, artifacts: [artifact] }),
    downloadArtifact: async () => archive,
    readGit: command => (command === 'head' ? headSha : '')
  }
  const request: PreviewArtifactRequest = {
    checkedOutHeadSha: headSha,
    expectedReceiptSha256: receipt.sha256,
    repository: 'serpcompany/directory-platform-d1',
    runId,
    siteId
  }
  return { archive, artifact, dependencies, evidence, receipt, request, run }
}

describe('exact-main Preview artifact trust', () => {
  it('downloads the sole requested successful artifact and fully validates its sealed receipt', async () => {
    const fixture = artifactFixture()
    await expect(
      downloadTrustedPreviewReceipt(fixture.request, fixture.dependencies)
    ).resolves.toEqual(expect.objectContaining({ artifactId: 99, runId, siteId }))
  })

  it.each([
    [
      'repository',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.run.repository.full_name = 'fork/repo'
      },
      'registered repository'
    ],
    [
      'event',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.run.event = 'push'
      },
      'exact successful main'
    ],
    [
      'workflow path',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.run.path = '.github/workflows/other.yml'
      },
      'exact successful main'
    ],
    [
      'branch',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.run.head_branch = 'topic'
      },
      'exact successful main'
    ],
    [
      'head SHA',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.run.head_sha = 'b'.repeat(40)
      },
      'exact successful main'
    ],
    [
      'conclusion',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.run.conclusion = 'failure'
      },
      'exact successful main'
    ],
    [
      'expired artifact',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.artifact.expired = true
      },
      'not bound'
    ],
    [
      'artifact run',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.artifact.workflow_run.id = 43
      },
      'not bound'
    ],
    [
      'archive digest',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.artifact.digest = `sha256:${'0'.repeat(64)}`
      },
      'does not match GitHub metadata'
    ],
    [
      'protected receipt digest',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.request.expectedReceiptSha256 = '0'.repeat(64)
      },
      'embedded and protected trust'
    ],
    [
      'checked-out HEAD',
      (fixture: ReturnType<typeof artifactFixture>) => {
        fixture.dependencies.readGit = command => (command === 'head' ? 'b'.repeat(40) : '')
      },
      'clean checkout'
    ]
  ])('rejects a %s mismatch', async (_label, mutate, message) => {
    const fixture = artifactFixture()
    mutate(fixture)
    await expect(
      downloadTrustedPreviewReceipt(fixture.request, fixture.dependencies)
    ).rejects.toThrow(message)
  })

  it('rejects tampered embedded evidence even when the protected digest is changed with it', async () => {
    const fixture = artifactFixture()
    fixture.evidence.migration.exactParity = false
    fixture.receipt.sha256 = previewReceiptSha256(fixture.evidence)
    fixture.request.expectedReceiptSha256 = fixture.receipt.sha256
    const archive = storedZip(
      'd1-replatform-evidence/preview-receipt.json',
      JSON.stringify(fixture.receipt)
    )
    fixture.artifact.digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
    fixture.dependencies.downloadArtifact = async () => archive
    const result = expect(
      downloadTrustedPreviewReceipt(fixture.request, fixture.dependencies)
    ).rejects
    await result.toThrow('migration.exactParity')
    await result.toThrow('Remediation:')
    await result.toThrow('Documentation: docs/D1_CUTOVER.md')
  })

  it('adds the complete failure contract to delegated Site parsing', async () => {
    const fixture = artifactFixture()
    fixture.request.siteId = 'unknown.example'
    const result = expect(
      downloadTrustedPreviewReceipt(fixture.request, fixture.dependencies)
    ).rejects
    await result.toThrow('Site selection is invalid')
    await result.toThrow('Why this matters:')
    await result.toThrow('Remediation:')
    await result.toThrow('Documentation: docs/D1_CUTOVER.md')
  })
})

function productionFixture() {
  const request: ProductionIdentityRequest = {
    accountId: 'account-id',
    allowedSiteIds: [siteId],
    checkedOutHeadSha: headSha,
    eventName: 'workflow_dispatch',
    expectedAccountId: 'account-id',
    githubRef: 'refs/heads/main',
    githubSha: headSha,
    protectedEnvironment: 'production',
    repository: 'serpcompany/directory-platform-d1',
    replacementDatabaseId: 'replacement-uuid',
    replacementDatabaseName: 'replacement-name',
    sourceDatabaseId: 'source-uuid',
    sourceDatabaseName: 'source-name',
    siteId,
    workerName: 'worker-name'
  }
  const responses = {
    account: { success: true, result: { id: 'account-id' } },
    source: { success: true, result: { uuid: 'source-uuid', name: 'source-name' } },
    replacement: { success: true, result: { uuid: 'replacement-uuid', name: 'replacement-name' } },
    worker: { success: true, result: { name: 'worker-name' } },
    zones: {
      success: true,
      result: [{ id: 'zone-id', name: siteId, status: 'active', account: { id: 'account-id' } }]
    },
    routes: {
      success: true,
      result: [{ id: 'route-id', pattern: `${siteId}/*`, script: 'worker-name' }]
    },
    deployments: {
      success: true,
      result: {
        deployments: [
          { id: 'deployment-id', versions: [{ percentage: 100, version_id: 'version-id' }] }
        ]
      }
    },
    version: {
      success: true,
      result: {
        id: 'version-id',
        resources: { bindings: [{ type: 'd1', name: 'DB', database_id: 'source-uuid' }] }
      }
    }
  }
  const dependencies: ProductionIdentityDependencies = {
    fetchAccount: async () => responses.account,
    fetchDatabase: async (_accountId, databaseId) =>
      databaseId === 'source-uuid' ? responses.source : responses.replacement,
    fetchDeployments: async () => responses.deployments,
    fetchRoutes: async () => responses.routes,
    fetchWorker: async () => responses.worker,
    fetchWorkerVersion: async () => responses.version,
    fetchZones: async () => responses.zones,
    readGit: command => (command === 'head' ? headSha : '')
  }
  return { dependencies, request, responses }
}

describe('Production read-only identity preflight', () => {
  it('proves exact account, D1, Worker, zone, route, deployment, version, binding, Site, and environment identity', async () => {
    const fixture = productionFixture()
    await expect(
      verifyProductionIdentityPreflight(
        fixture.request,
        fixture.dependencies,
        () => '2026-09-25T00:00:00.000Z'
      )
    ).resolves.toEqual({
      activeDeploymentId: 'deployment-id',
      activeVersionId: 'version-id',
      accountId: 'account-id',
      allowedSiteIds: [siteId],
      currentDatabaseId: 'source-uuid',
      protectedEnvironment: 'production',
      replacementDatabaseId: 'replacement-uuid',
      replacementDatabaseName: 'replacement-name',
      routeId: 'route-id',
      routePattern: `${siteId}/*`,
      siteId,
      sourceDatabaseId: 'source-uuid',
      sourceDatabaseName: 'source-name',
      verifiedAt: '2026-09-25T00:00:00.000Z',
      workerName: 'worker-name',
      zoneId: 'zone-id',
      zoneName: siteId
    })
  })

  it.each([
    [
      'repository',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.repository = 'fork/repo'
      },
      'registered repository'
    ],
    [
      'non-dispatch',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.eventName = 'push'
      },
      'workflow_dispatch'
    ],
    [
      'non-main',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.githubRef = 'refs/heads/topic'
      },
      'workflow_dispatch'
    ],
    [
      'head drift',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.githubSha = 'b'.repeat(40)
      },
      'workflow_dispatch'
    ],
    [
      'environment',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.protectedEnvironment = 'wrong'
      },
      'Protected Production environment'
    ],
    [
      'Site set',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.allowedSiteIds = [siteId, 'pornvideodownloaders.com']
      },
      'must contain only'
    ],
    [
      'account config',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.expectedAccountId = 'wrong'
      },
      'account IDs differ'
    ],
    [
      'account observation',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.account.result.id = 'wrong'
      },
      'Observed Cloudflare account'
    ],
    [
      'D1 alias',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.request.replacementDatabaseId = 'source-uuid'
      },
      'must be distinct'
    ],
    [
      'source D1',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.source.result.name = 'wrong'
      },
      'Observed Production D1'
    ],
    [
      'Worker service',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.worker.result.name = 'wrong'
      },
      'Worker service differs'
    ],
    [
      'zone',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.zones.result[0]!.status = 'pending'
      },
      'zone does not match'
    ],
    [
      'route',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.routes.result[0]!.script = 'wrong'
      },
      'apex route'
    ],
    [
      'gradual deployment',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.deployments.result.deployments[0]!.versions = [
          { percentage: 50, version_id: 'version-id' }
        ]
      },
      '100 percent'
    ],
    [
      'version ID',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.version.result.id = 'wrong'
      },
      'version differs'
    ],
    [
      'DB binding',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.responses.version.result.resources.bindings[0]!.database_id = 'replacement-uuid'
      },
      'not bound to the protected source'
    ],
    [
      'dirty checkout',
      (fixture: ReturnType<typeof productionFixture>) => {
        fixture.dependencies.readGit = command => (command === 'head' ? headSha : 'dirty')
      },
      'clean checkout'
    ]
  ])('rejects a %s mismatch with remediation', async (_label, mutate, message) => {
    const fixture = productionFixture()
    mutate(fixture)
    await expect(
      verifyProductionIdentityPreflight(fixture.request, fixture.dependencies)
    ).rejects.toThrow(message)
    await expect(
      verifyProductionIdentityPreflight(fixture.request, fixture.dependencies)
    ).rejects.toThrow('Remediation:')
  })
})
