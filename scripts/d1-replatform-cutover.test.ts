import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { pvdReviewedPrivateTableProof } from './d1-preview-sanitize'
import {
  assertRemoteIdentity,
  attestPreviewWorker,
  buildCutoverPlan,
  freshMigrationChecksum,
  observePreviewDeployment,
  observePreviewSecretDeployment,
  previewReceiptSha256,
  previewRehearsalSecretNames,
  validateCutoverEvidence,
  validateReplatformTemplate,
  verifyPreviewRemoteIdentity
} from './d1-replatform-cutover'
import { canonicalLegacyMigrationNames } from './d1-replatform-inventory'
import { siteTargets } from './site-targets'

const commitSha = 'a'.repeat(40)
const checksum = freshMigrationChecksum()

function baseEvidence(
  environment: 'preview' | 'production',
  siteId: 'pornvideodownloaders.com' | 'serp.software' = 'serp.software'
) {
  const exactIdentity = {
    siteId,
    environment,
    protectedEnvironment: siteTargets[siteId].protectedEnvironment[environment],
    allowedSiteIds: [siteId],
    accountId: 'account-id',
    sourceDatabaseId: 'source-uuid',
    sourceDatabaseName: 'source-name',
    targetDatabaseId: 'target-uuid',
    targetDatabaseName: 'target-name',
    workerName: 'worker-name',
    workerHostname: `${environment}.example.test`
  }
  const exactAttestation = {
    bindingNonce: 'binding-nonce',
    commit: commitSha,
    environment,
    hostname: `${environment}.example.test`,
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
    environment,
    commitSha,
    migrationChecksum: checksum,
    initialWorkerDeployment: {
      absentSecretNames: [...previewRehearsalSecretNames],
      captureSource: 'wrangler-deploy-output',
      capturedVersionId: 'version-id',
      commitSha,
      credentialFree: true,
      deploymentId: 'deployment-id',
      generation: 'legacy',
      hostname: `${environment}.example.test`,
      scriptEtag: 'script-etag',
      serviceName: 'worker-name',
      siteId,
      sourceDatabaseId: 'source-uuid',
      trafficPercentage: 100,
      versionId: 'version-id'
    },
    secretWorkerDeployment: {
      commitSha,
      deploymentId: 'secret-deployment-id',
      generation: 'legacy',
      hostname: `${environment}.example.test`,
      previousDeploymentId: 'deployment-id',
      previousVersionId: 'version-id',
      scriptEtag: 'script-etag',
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
      expected: exactIdentity,
      observed: { ...exactIdentity },
      attestation: { expected: exactAttestation, observed: { ...exactAttestation } }
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
    nothingDeleted: true
  }
}

const controlledPreviewData = {
  policy: 'controlled-fixtures',
  copiedProduction: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
  previewGenerated: { capabilityRows: 1, notificationSecretRows: 1, rateLimitRows: 1 }
}

const pvdSanitizedPreviewData = {
  policy: 'sanitized-snapshot',
  copiedProduction: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
  previewGenerated: { capabilityRows: 1, notificationSecretRows: 1, rateLimitRows: 1 },
  sanitization: {
    mode: 'sanitized',
    backupSha256: '1'.repeat(64),
    beforeChecksum: '2'.repeat(64),
    afterChecksum: 'e'.repeat(64),
    sourceDatabaseId: 'source-uuid',
    reviewedPrivateTableProof: pvdReviewedPrivateTableProof,
    journalDigest: '3'.repeat(64),
    resultDigest: '4'.repeat(64),
    deletedPrivateRows: 3,
    submissionId: 'submission-id',
    eventId: 'event-id',
    rateFingerprint: 'rate-fingerprint'
  }
}

describe('D1 replatform cutover preparation', () => {
  it('keeps legacy and replacement templates separate for every Site', () => {
    for (const target of Object.values(siteTargets)) {
      for (const environment of ['preview', 'production'] as const) {
        const legacyPath =
          environment === 'preview'
            ? target.remote.previewConfigPath
            : target.remote.productionConfigPath
        const replacementPath =
          environment === 'preview'
            ? target.replatform.previewConfigPath
            : target.replatform.productionConfigPath
        expect(legacyPath).not.toBe(replacementPath)
        expect(readFileSync(legacyPath, 'utf8')).toContain('../../../d1/migrations')
        const replacement = readFileSync(replacementPath, 'utf8')
        expect(() => validateReplatformTemplate(target.siteId, environment)).not.toThrow()
        expect(replacement).toContain('"compatibility_date": "2026-07-13"')
        if (environment === 'preview') {
          expect(replacement).toContain('"global_fetch_strictly_public"')
        } else {
          expect(replacement).not.toContain('"global_fetch_strictly_public"')
        }
      }
    }
    expect(siteTargets['serp.software'].protectedEnvironment.preview).toBe('serp-software-preview')
    expect(siteTargets['pornvideodownloaders.com'].protectedEnvironment.preview).toBe(
      'pornvideodownloaders-preview'
    )
  })

  it('rejects extra bindings, wrong fresh paths, routes, flags, placeholders, and cross-Site references', () => {
    const sourcePath = siteTargets['serp.software'].replatform.previewConfigPath
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Record<string, unknown>
    const cases: Array<[string, (config: Record<string, unknown>) => void]> = [
      ['extra binding', config => Object.assign(config, { kv_namespaces: [] })],
      [
        'wrong history',
        config => {
          ;(config.d1_databases as Array<Record<string, unknown>>)[0].migrations_dir =
            '../../../d1/migrations'
        }
      ],
      [
        'preview route',
        config =>
          Object.assign(config, {
            routes: [{ pattern: 'serp.software/*', zone_name: 'serp.software' }]
          })
      ],
      [
        'wrong flags',
        config => Object.assign(config, { compatibility_flags: ['nodejs_compat_v2'] })
      ],
      [
        'wrong placeholder',
        config => {
          ;(config.d1_databases as Array<Record<string, unknown>>)[0].database_id =
            '$' + '{CLOUDFLARE_D1_PRODUCTION_DATABASE_ID}'
        }
      ],
      [
        'cross Site',
        config => {
          ;(config.vars as Record<string, unknown>).SITE_ID = 'pornvideodownloaders.com'
        }
      ]
    ]
    for (const [name, mutate] of cases) {
      const candidate = structuredClone(source)
      mutate(candidate)
      expect(
        () =>
          validateReplatformTemplate(
            'serp.software',
            'preview',
            sourcePath,
            JSON.stringify(candidate)
          ),
        name
      ).toThrow()
    }
  })

  it('emits inert plans with ordered preview and production gates', () => {
    const preview = buildCutoverPlan('serp.software', 'preview')
    const production = buildCutoverPlan('serp.software', 'production')
    expect(preview.executesRemoteCommand).toBe(false)
    expect(preview.orderedGates).toContain('repeat-and-prove-verified-no-op')
    expect(production.orderedGates[0]).toBe('require-matching-sealed-preview-evidence')
    expect(production.orderedGates).toContain('acquire-one-site-wide-mutation-lock')
    expect(preview.migrationChecksum).toBe(production.migrationChecksum)
  })

  it('fails closed when a read-only observed identity differs from the protected expectation', () => {
    const identity = baseEvidence('preview').identity
    expect(() => assertRemoteIdentity('serp.software', 'preview', identity)).not.toThrow()
    expect(() =>
      assertRemoteIdentity('serp.software', 'preview', {
        ...identity,
        observed: { ...identity.observed, targetDatabaseId: 'wrong-target' }
      })
    ).toThrow('does not match')
    expect(() =>
      assertRemoteIdentity('serp.software', 'preview', {
        ...identity,
        observed: { ...identity.observed, allowedSiteIds: ['serp.software', 'example.com'] }
      })
    ).toThrow('must contain exactly')
  })

  it('binds observed remote identity to the protected workflow and checked-out GITHUB_SHA', async () => {
    const env = {
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: commitSha,
      GITHUB_WORKFLOW_REF:
        'owner/repo/.github/workflows/rehearse-d1-replatform-preview.yml@refs/heads/main',
      WORKER_PRODUCTION_CONFIRM: 'rehearse-serp.software-preview',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_EXPECTED_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'token',
      CLOUDFLARE_D1_PREVIEW_DATABASE_ID: 'source-uuid',
      CLOUDFLARE_D1_PREVIEW_DATABASE_NAME: 'source-name',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: 'target-uuid',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: 'target-name',
      CLOUDFLARE_WORKER_PREVIEW_NAME: 'worker-name',
      PREVIEW_BASE_URL: 'https://worker-name.test-subdomain.workers.dev/',
      REPLATFORM_SOURCE_DEPLOY_VERSION_ID: 'version-id',
      REPLATFORM_PRE_SECRET_DEPLOYMENT_ID: 'deployment-id',
      REPLATFORM_PRE_SECRET_VERSION_ID: 'version-id',
      REPLATFORM_PRE_SECRET_SCRIPT_ETAG: 'script-etag'
    }
    const dependencies = {
      fetchAccount: async () => ({ success: true, result: { id: 'account-id' } }),
      fetchDeployments: async () => ({
        success: true,
        result: {
          deployments: [
            {
              id: 'deployment-id',
              versions: [{ percentage: 100, version_id: 'version-id' }]
            }
          ]
        }
      }),
      fetchWorker: async () => ({ success: true, result: { name: 'worker-name' } }),
      fetchWorkersSubdomain: async () => ({
        success: true,
        result: { subdomain: 'test-subdomain' }
      }),
      fetchWorkerVersion: async () => ({
        success: true,
        result: {
          id: 'version-id',
          resources: {
            bindings: [{ database_id: 'source-uuid', name: 'DB', type: 'd1' }],
            script: { etag: 'script-etag', last_deployed_from: 'wrangler' }
          }
        }
      }),
      readD1Info: (name: string) =>
        name === 'source-name' ? { name, uuid: 'source-uuid' } : { name, uuid: 'target-uuid' },
      readGit: (command: 'head' | 'status') => (command === 'head' ? commitSha : '')
    }
    await expect(verifyPreviewRemoteIdentity('serp.software', env, dependencies)).resolves.toEqual(
      expect.objectContaining({ expected: expect.objectContaining({ accountId: 'account-id' }) })
    )
    await expect(
      verifyPreviewRemoteIdentity(
        'serp.software',
        { ...env, PREVIEW_BASE_URL: 'https://wrong-host.example/' },
        dependencies
      )
    ).rejects.toThrow('workers.dev hostname')
    await expect(observePreviewDeployment('serp.software', env, dependencies)).resolves.toEqual(
      expect.objectContaining({
        activeDeployment: expect.objectContaining({
          commitSha,
          generation: 'legacy',
          scriptEtag: 'script-etag',
          sourceDatabaseId: 'source-uuid',
          versionId: 'version-id'
        })
      })
    )
    await expect(
      observePreviewDeployment('serp.software', env, {
        ...dependencies,
        fetchWorkerVersion: async () => ({
          success: true,
          result: {
            id: 'version-id',
            resources: {
              bindings: [
                { database_id: 'source-uuid', name: 'DB', type: 'd1' },
                { name: 'REPLATFORM_PREVIEW_SIGNING_SECRET', type: 'secret_text' }
              ],
              script: { etag: 'script-etag' }
            }
          }
        })
      })
    ).rejects.toThrow('Manual recovery is required')
    const secretDependencies = {
      ...dependencies,
      fetchDeployments: async () => ({
        success: true,
        result: {
          deployments: [
            {
              id: 'secret-deployment-id',
              versions: [{ percentage: 100, version_id: 'secret-version-id' }]
            },
            {
              id: 'deployment-id',
              versions: [{ percentage: 100, version_id: 'version-id' }]
            }
          ]
        }
      }),
      fetchWorkerVersion: async () => ({
        success: true,
        result: {
          id: 'secret-version-id',
          resources: {
            bindings: [
              { database_id: 'source-uuid', name: 'DB', type: 'd1' },
              ...previewRehearsalSecretNames.map(name => ({ name, type: 'secret_text' }))
            ],
            script: { etag: 'script-etag', last_deployed_from: 'wrangler' }
          }
        }
      })
    }
    await expect(
      observePreviewSecretDeployment('serp.software', env, secretDependencies)
    ).resolves.toEqual(
      expect.objectContaining({
        activeDeployment: expect.objectContaining({
          previousVersionId: 'version-id',
          scriptEtag: 'script-etag',
          transitionSource: 'wrangler-secret-bulk',
          versionId: 'secret-version-id'
        })
      })
    )
    await expect(
      observePreviewSecretDeployment('serp.software', env, {
        ...secretDependencies,
        fetchDeployments: async () => ({
          success: true,
          result: {
            deployments: [
              {
                id: 'concurrent-dashboard-deployment',
                versions: [{ percentage: 100, version_id: 'dashboard-version-id' }]
              },
              {
                id: 'secret-deployment-id',
                versions: [{ percentage: 100, version_id: 'secret-version-id' }]
              },
              {
                id: 'deployment-id',
                versions: [{ percentage: 100, version_id: 'version-id' }]
              }
            ]
          }
        })
      })
    ).rejects.toThrow('exactly one deployment')
    await expect(
      observePreviewSecretDeployment('serp.software', env, {
        ...secretDependencies,
        fetchWorkerVersion: async () => ({
          success: true,
          result: {
            id: 'secret-version-id',
            resources: {
              bindings: [
                { database_id: 'source-uuid', name: 'DB', type: 'd1' },
                ...previewRehearsalSecretNames.map(name => ({ name, type: 'secret_text' }))
              ],
              script: { etag: 'changed-script-etag' }
            }
          }
        })
      })
    ).rejects.toThrow('changed the reviewed Worker script content')
    await expect(
      observePreviewDeployment('serp.software', env, {
        ...dependencies,
        fetchDeployments: async () => ({
          success: true,
          result: {
            deployments: [
              {
                id: 'concurrent-dashboard-deployment',
                versions: [{ percentage: 100, version_id: 'dashboard-version-id' }]
              }
            ]
          }
        })
      })
    ).rejects.toThrow('immediately preceding deploy')
    await expect(
      observePreviewDeployment('serp.software', env, {
        ...dependencies,
        fetchWorkerVersion: async () => ({
          success: true,
          result: {
            id: 'version-id',
            resources: {
              bindings: [{ database_id: 'target-uuid', name: 'DB', type: 'd1' }],
              script: { etag: 'script-etag' }
            }
          }
        })
      })
    ).rejects.toThrow('legacy Preview source D1')
    await expect(
      verifyPreviewRemoteIdentity(
        'serp.software',
        env,
        { ...dependencies, fetchWorker: async () => ({ success: true, result: null }) },
        { allowConfiguredMissingWorker: true }
      )
    ).rejects.toThrow('does not exist')
    await expect(
      verifyPreviewRemoteIdentity('serp.software', env, {
        ...dependencies,
        fetchWorker: async () => ({ success: true, result: { name: 'wrong' } })
      })
    ).rejects.toThrow('workerName')
    await expect(
      verifyPreviewRemoteIdentity(
        'pornvideodownloaders.com',
        {
          ...env,
          WORKER_PRODUCTION_CONFIRM: 'rehearse-pornvideodownloaders.com-preview',
          CLOUDFLARE_WORKER_PREVIEW_NAME: 'pvd-preview-worker',
          PREVIEW_BASE_URL: 'https://pvd-preview.example.test/'
        },
        { ...dependencies, fetchWorker: async () => ({ success: true, result: null }) },
        { allowConfiguredMissingWorker: true }
      )
    ).rejects.toThrow('does not exist')
    await expect(
      verifyPreviewRemoteIdentity(
        'serp.software',
        { ...env, GITHUB_SHA: 'd'.repeat(40) },
        dependencies
      )
    ).rejects.toThrow('checked-out HEAD')
    for (const ref of ['refs/heads/codex/other', 'refs/tags/preview', 'refs/pull/72/merge'])
      await expect(
        verifyPreviewRemoteIdentity(
          'serp.software',
          {
            ...env,
            GITHUB_REF: ref,
            GITHUB_WORKFLOW_REF: `owner/repo/.github/workflows/rehearse-d1-replatform-preview.yml@${ref}`
          },
          dependencies
        )
      ).rejects.toThrow('protected rehearsal workflow')
  })

  it('binds deployed Worker attestation to service, host, commit, run, and target marker', async () => {
    const env = {
      PREVIEW_BASE_URL: 'https://preview.example.test/',
      REPLATFORM_PREVIEW_RUN_ID: 'run-1',
      REPLATFORM_PREVIEW_SIGNING_SECRET: 's'.repeat(32),
      REPLATFORM_PREVIEW_BINDING_NONCE: 'nonce-1',
      CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: 'target-id',
      CLOUDFLARE_WORKER_PREVIEW_NAME: 'worker-name',
      GITHUB_SHA: commitSha
    }
    const observed = {
      bindingNonce: 'nonce-1',
      commit: commitSha,
      environment: 'preview',
      hostname: 'preview.example.test',
      run: 'run-1',
      service: 'worker-name',
      siteId: 'serp.software'
    }
    const fetcher = async () => Response.json(observed)
    await expect(attestPreviewWorker('serp.software', env, fetcher)).resolves.toEqual({
      expected: observed,
      observed
    })
    await expect(
      attestPreviewWorker('serp.software', env, async () =>
        Response.json({ ...observed, commit: 'd'.repeat(40) })
      )
    ).rejects.toThrow('commit mismatch')

    let delayedNow = 0
    const delayedUrls: string[] = []
    const delayedStatuses = [404, 503, 200]
    const delayedFetcher = async (input: RequestInfo | URL) => {
      delayedUrls.push(String(input))
      const status = delayedStatuses.shift()
      return status === 200 ? Response.json(observed) : new Response(null, { status })
    }
    await expect(
      attestPreviewWorker('serp.software', env, delayedFetcher, {
        maxWaitMs: 2_000,
        now: () => delayedNow,
        sleep: async milliseconds => {
          delayedNow += milliseconds
        }
      })
    ).resolves.toEqual({ expected: observed, observed })
    expect(delayedUrls).toHaveLength(3)
    expect(new Set(delayedUrls.map(value => new URL(value).searchParams.get('token'))).size).toBe(1)

    let timeoutNow = 0
    let timeoutCalls = 0
    await expect(
      attestPreviewWorker(
        'serp.software',
        env,
        async () => {
          timeoutCalls += 1
          return new Response(null, { status: 404 })
        },
        {
          maxWaitMs: 500,
          now: () => timeoutNow,
          sleep: async milliseconds => {
            timeoutNow += milliseconds
          }
        }
      )
    ).rejects.toThrow('did not propagate')
    expect(timeoutCalls).toBeGreaterThan(1)

    let hungCalls = 0
    await expect(
      attestPreviewWorker(
        'serp.software',
        env,
        async (_input, init) => {
          hungCalls += 1
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true
            })
          })
        },
        {
          cancelAbort: () => undefined,
          maxWaitMs: 500,
          now: () => 0,
          scheduleAbort: callback => {
            queueMicrotask(callback)
            return 'abort-handle'
          },
          sleep: async () => undefined
        }
      )
    ).rejects.toThrow('did not propagate')
    expect(hungCalls).toBe(1)

    let lateNow = 0
    let lateCalls = 0
    await expect(
      attestPreviewWorker(
        'serp.software',
        env,
        async () => {
          lateCalls += 1
          lateNow = 501
          return Response.json(observed)
        },
        {
          cancelAbort: () => undefined,
          maxWaitMs: 500,
          now: () => lateNow,
          scheduleAbort: () => 'abort-handle',
          sleep: async () => undefined
        }
      )
    ).rejects.toThrow('did not propagate')
    expect(lateCalls).toBe(1)

    let mismatchCalls = 0
    await expect(
      attestPreviewWorker(
        'serp.software',
        env,
        async () => {
          mismatchCalls += 1
          return Response.json({ ...observed, service: 'wrong-worker' })
        },
        { maxWaitMs: 2_000, sleep: async () => undefined }
      )
    ).rejects.toThrow('service mismatch')
    expect(mismatchCalls).toBe(1)
  })

  it('accepts controlled Preview evidence and rejects private state', () => {
    const evidence = {
      ...baseEvidence('preview', 'pornvideodownloaders.com'),
      previewData: pvdSanitizedPreviewData
    }
    expect(() => validateCutoverEvidence(evidence, { commitSha })).not.toThrow()
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          initialWorkerDeployment: {
            ...evidence.initialWorkerDeployment,
            credentialFree: false
          }
        },
        { commitSha }
      )
    ).toThrow('source Preview identity')
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          initialWorkerDeployment: {
            ...evidence.initialWorkerDeployment,
            sourceDatabaseId: 'target-uuid'
          }
        },
        { commitSha }
      )
    ).toThrow('source Preview identity')
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          secretWorkerDeployment: {
            ...evidence.secretWorkerDeployment,
            scriptEtag: 'different-script-etag'
          }
        },
        { commitSha }
      )
    ).toThrow('reviewed Worker code')
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          previewData: {
            ...evidence.previewData,
            copiedProduction: { ...evidence.previewData.copiedProduction, rateLimitRows: 1 }
          }
        },
        { commitSha }
      )
    ).toThrow('must be zero')
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          previewData: {
            ...evidence.previewData,
            sanitization: {
              ...evidence.previewData.sanitization,
              reviewedPrivateTableProof: {
                ...pvdReviewedPrivateTableProof,
                listing_submissions: {
                  ...pvdReviewedPrivateTableProof.listing_submissions,
                  checksum: '9'.repeat(64)
                }
              }
            }
          }
        },
        { commitSha }
      )
    ).toThrow('reviewed source proof')
  })

  it('requires exact Preview binding, lock, freeze/replay, rollback, and retention evidence for Production', () => {
    const previewEvidence = {
      ...baseEvidence('preview'),
      previewData: controlledPreviewData
    }
    const digest = previewReceiptSha256(previewEvidence)
    const evidence = {
      ...baseEvidence('production'),
      previewReceipt: { evidence: previewEvidence, sha256: digest },
      separateProductionApproval: true,
      production: {
        siteWideMutationLock: true,
        finalSnapshotCapturedAfterLock: true,
        parityBeforeBindingChange: true,
        oldDatabaseReadOnly: true,
        replayProven: false,
        frozenMutations: ['submission', 'publication', 'approval', 'notification'],
        retentionDays: 30,
        backupArtifact: 'retained-artifact-id',
        rollbackCommand: 'protected workflow rollback operation',
        responsibleMaintainer: 'maintainer-login'
      }
    }
    expect(() =>
      validateCutoverEvidence(evidence, { commitSha, previewReceiptSha256: digest })
    ).not.toThrow()
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          previewReceipt: {
            ...evidence.previewReceipt,
            evidence: { ...previewEvidence, commitSha: 'd'.repeat(40) }
          }
        },
        { commitSha, previewReceiptSha256: digest }
      )
    ).toThrow('content does not match')
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          production: { ...evidence.production, frozenMutations: [] }
        },
        { commitSha, previewReceiptSha256: digest }
      )
    ).toThrow('must contain exactly')
  })

  it('rejects a caller-invented commit even when evidence is otherwise complete', () => {
    const evidence = {
      ...baseEvidence('preview'),
      previewData: {
        policy: 'controlled-fixtures',
        copiedProduction: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
        previewGenerated: { capabilityRows: 1, notificationSecretRows: 1, rateLimitRows: 1 }
      }
    }
    expect(() => validateCutoverEvidence(evidence, { commitSha: 'd'.repeat(40) })).toThrow(
      'trusted GITHUB_SHA'
    )
  })

  it('rejects a tampered full legacy source classification proof', () => {
    const evidence = {
      ...baseEvidence('preview'),
      previewData: {
        policy: 'controlled-fixtures',
        copiedProduction: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
        previewGenerated: { capabilityRows: 1, notificationSecretRows: 1, rateLimitRows: 1 }
      }
    }
    const legacySource = evidence.legacySource
    expect(() =>
      validateCutoverEvidence(
        {
          ...evidence,
          legacySource: {
            ...legacySource,
            classificationArtifact: {
              ...legacySource.classificationArtifact,
              observed: {
                ...legacySource.classificationArtifact.observed,
                migrationNames: [...canonicalLegacyMigrationNames, '0010_forward.sql']
              }
            }
          }
        },
        { commitSha }
      )
    ).toThrow('artifact digest mismatch')
  })

  it('rejects semantically tampered classification fields even after recomputing the digest', () => {
    const evidence = {
      ...baseEvidence('preview'),
      previewData: {
        policy: 'controlled-fixtures',
        copiedProduction: { capabilityRows: 0, notificationSecretRows: 0, rateLimitRows: 0 },
        previewGenerated: { capabilityRows: 1, notificationSecretRows: 1, rateLimitRows: 1 }
      }
    }
    const variants = [
      (legacy: typeof evidence.legacySource) => {
        legacy.classificationArtifact.observed.applicationSnapshot.checksum = 'b'.repeat(64)
      },
      (legacy: typeof evidence.legacySource) => {
        legacy.checksum = 'b'.repeat(64)
      },
      (legacy: typeof evidence.legacySource) => {
        legacy.classificationArtifact.expected.siteId = 'other.example'
      },
      (legacy: typeof evidence.legacySource) => {
        legacy.classificationArtifact.observed.hasMigrationLedger = false
      }
    ]
    for (const mutate of variants) {
      const legacySource = structuredClone(evidence.legacySource)
      mutate(legacySource)
      legacySource.classificationDigest = previewReceiptSha256(legacySource.classificationArtifact)
      expect(() => validateCutoverEvidence({ ...evidence, legacySource }, { commitSha })).toThrow()
    }
  })

  it('keeps the preparation workflow credential-free and non-mutating', () => {
    const raw = readFileSync('.github/workflows/prepare-d1-replatform.yml', 'utf8')
    const workflow = yaml.load(raw) as {
      permissions: unknown
      jobs: { prepare: { steps: Array<{ run?: string }> } }
    }
    const commands = workflow.jobs.prepare.steps.map(step => step.run ?? '').join('\n')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(raw).not.toMatch(/CLOUDFLARE_API_TOKEN|secrets\./u)
    expect(commands).not.toMatch(/--remote|\bd1\s+(?:create|delete|execute|export)|\bdeploy\b/u)
    expect(commands).toContain('d1-replatform-cutover.ts plan')
  })

  it('prepares an approval-gated Preview executor with ordered migrate, browser, repeat, and rollback gates', () => {
    const raw = readFileSync('.github/workflows/rehearse-d1-replatform-preview.yml', 'utf8')
    const workflow = yaml.load(raw) as {
      permissions: unknown
      jobs: {
        rehearse: {
          environment: { name: string }
          if: string
          steps: Array<{ name?: string; run?: string }>
        }
      }
    }
    const job = workflow.jobs.rehearse
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).not.toContain('refs/heads/codex/')
    expect(raw).toContain('ref: $' + '{{ github.sha }}')
    expect(job.environment.name).toContain('serp-software-preview')
    expect(raw).not.toContain('cutover-')
    const names = job.steps.map(step => step.name)
    const ordered = [
      'Read-only preflight account, D1, and optional Worker identity',
      'Deploy and observe exact credential-free source-bound Worker',
      'Retain pre-bootstrap source Preview backup',
      'Upload PVD source recovery backup before sanitization',
      'Re-observe PVD identity before bounded sanitization',
      'Sanitize exact known PVD Preview private graph',
      'Re-observe identities before controlled legacy source initialization',
      'Initialize or verify controlled legacy Preview source',
      'Re-observe identities before populated source rollback backup',
      'Retain populated source rollback backup',
      'Apply fresh schema, import controlled data, and verify exact parity',
      'Deploy replacement binding from exact commit',
      'Run critical Catalog and Submission browser journeys',
      'Repeat import and prove verified no-op with unchanged parity',
      'Rehearse nondestructive old-binding rollback and restoration',
      'Build and validate sealed exact-commit Preview receipt',
      'Seal trusted Preview evidence'
    ].map(name => names.indexOf(name))
    expect(ordered.every(index => index >= 0)).toBe(true)
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right))
    expect(raw).toContain('D1_RELEASE_GENERATION: replatform')
    expect(raw).toContain('validate-replatform preview')
    expect(raw).toContain('d1-preview-submission-journey.ts')
    expect(raw).toContain('d1-preview-sanitize.ts')
    expect(raw).toContain('pvd-sanitization-journal.json')
    expect(raw).toContain("'sanitized-snapshot' || 'controlled-fixtures'")
    expect(raw).toContain('--sanitization-journal')
    expect(raw).toContain('--sanitization-result')
    expect(raw).toContain("if: inputs.site_id == 'pornvideodownloaders.com'")
    const backupUpload = raw.indexOf('Upload PVD source recovery backup before sanitization')
    const sanitization = raw.indexOf('Sanitize exact known PVD Preview private graph')
    expect(backupUpload).toBeGreaterThan(0)
    expect(sanitization).toBeGreaterThan(backupUpload)
    expect(raw).not.toContain('submission-verification.spec.ts')
    expect(raw.match(/verify-preview-identity/gu)?.length).toBeGreaterThanOrEqual(7)
    expect(raw).toContain('Install transient Preview rehearsal secrets')
    expect(raw).toContain('Remove transient Preview rehearsal authority and binding marker')
    expect(raw).toContain('if: always()')
    expect(raw).toContain('wrangler secret delete')
    expect(raw).toContain('attest-preview')
    expect(raw).not.toContain(
      'REPLATFORM_EVIDENCE_DIR: $' + '{{ runner.temp }}/d1-replatform-evidence'
    )
    expect(raw).toContain(
      'echo "REPLATFORM_EVIDENCE_DIR=$RUNNER_TEMP/d1-replatform-evidence" >> "$GITHUB_ENV"'
    )
    expect(raw).toContain("PLAYWRIGHT_EXTERNAL_SERVER: '1'")
    expect(raw).toContain("'123Movies Video Downloader' || '321tube Video Downloader'")
    expect(raw).toContain("'123movies-downloader' || '321tube-downloader'")
    expect(raw).not.toContain('PLAYWRIGHT_WEB_SERVER_COMMAND: node -e')
    expect(raw).toContain('pnpm --filter e2e exec playwright install --with-deps chromium')
    expect(raw).not.toMatch(/(?:>|tee)\s+preview-[a-z-]+\.(?:json|txt)/u)
    expect(raw).not.toMatch(
      /scripts\/d1-[^\n]+\s+(?:preview-|catalog-|submission-|rollback-)[^/$"\s]+\.(?:json|txt)/u
    )
    expect(raw).toContain('replatform-secret-names-after-cleanup.json')
    expect(raw).toContain('d1-preview-attestation-marker.ts assert-absent')
    expect(raw).toContain('d1-preview-authority-probe.ts before')
    expect(raw).toContain('d1-preview-authority-probe.ts after')
    expect(raw).toContain('MANUAL_RECOVERY_REQUIRED.txt')
    const cleanupIdentity = raw.lastIndexOf('verify-preview-identity')
    const identityFailureExit = raw.indexOf('exit 1', cleanupIdentity)
    const firstCleanupMutation = raw.indexOf('d1-preview-submission-recovery.ts', cleanupIdentity)
    expect(cleanupIdentity).toBeGreaterThan(0)
    expect(identityFailureExit).toBeGreaterThan(cleanupIdentity)
    expect(firstCleanupMutation).toBeGreaterThan(identityFailureExit)
    expect(raw).toContain('Retain cleanup and manual-recovery evidence')
    expect(raw).toContain('preflight-preview-identity')
    expect(raw).toContain('observe-preview-deployment')
    expect(raw).toContain('preview-source-worker-deployment.json')
    expect(raw).toContain('preview-source-worker-deploy.log')
    expect(raw).toContain('REPLATFORM_SOURCE_DEPLOY_VERSION_ID')
    expect(raw).toContain('Current Version ID:')
    expect(raw).toContain('wrangler secret bulk')
    expect(raw).not.toContain('wrangler secret put')
    expect(raw).toContain('observe-preview-secret-deployment')
    expect(raw).toContain('preview-secret-worker-deployment.json')
    expect(raw).toContain('6 secrets successfully created')
    expect(raw).toContain('PREEXISTING_AUTHORITY_RECOVERY_REQUIRED')
    expect(raw).toContain('Reviewed source-bound Worker was not credential-free')
    expect(raw).toContain("worker_state\" = 'missing-allowed'")
    expect(raw).toContain('NO_REMOTE_CLEANUP_REQUIRED.txt')
    expect(raw).toContain('transient-authority-install-attempted')
    expect(raw).toContain('D1_RELEASE_GENERATION: legacy')
    expect(raw).toContain('d1-preview-source-classify.ts')
    expect(raw).toContain('d1-preview-measure.ts source')
    expect(raw).toContain('source-pre-bootstrap.sql')
    expect(raw).toContain('source-repeat-import.txt')
    expect(raw).toContain(
      'grep -F "import is a no-op" "$REPLATFORM_EVIDENCE_DIR/source-repeat-import.txt"'
    )
    const sourceStep =
      job.steps.find(step => step.name === 'Initialize or verify controlled legacy Preview source')
        ?.run ?? ''
    expect(sourceStep.indexOf('source_class')).toBeLessThan(
      sourceStep.indexOf('worker-release.ts migrate preview')
    )
    expect(sourceStep.indexOf('worker-release.ts verify preview')).toBeLessThan(
      sourceStep.indexOf('worker-release.ts migrate preview')
    )
    const classifier = readFileSync('scripts/d1-preview-source-classify.ts', 'utf8')
    expect(classifier).toContain('schemaFingerprint')
    expect(classifier).toContain('applicationSnapshotChecksum')
    expect(classifier).toContain('unexpectedUserObjects')
  })

  it('keeps the controlled badge fixture Preview-only and capability-gated', () => {
    for (const siteId of ['serp.software', 'pornvideodownloaders.com']) {
      const source = readFileSync(
        `apps/${siteId}/app/api/replatform/badge-fixture/route.ts`,
        'utf8'
      )
      expect(source).toContain("D1_RUNTIME_ENV !== 'preview'")
      expect(source).toContain('REPLATFORM_PREVIEW_SIGNING_SECRET')
      expect(source).toContain('REPLATFORM_PREVIEW_RUN_ID')
      expect(source).toContain("searchParams.get('token')")
      expect(source).not.toContain('BADGE_VERIFIER_USER_AGENT')
      expect(source).not.toMatch(/(?:INSERT|UPDATE|DELETE|DB\.)/u)
    }
  })

  it('freezes unrelated Preview intake while the rehearsal owns its exact fingerprint', () => {
    for (const siteId of ['serp.software', 'pornvideodownloaders.com']) {
      const source = readFileSync(`apps/${siteId}/app/api/submissions/route.ts`, 'utf8')
      expect(source).toContain("D1_RUNTIME_ENV === 'preview'")
      expect(source).toContain('REPLATFORM_PREVIEW_INTAKE_SECRET')
      expect(source).toContain("request.headers.get('x-replatform-preview-intake')")
    }
    const journey = readFileSync('scripts/d1-preview-submission-journey.ts', 'utf8')
    expect(journey).toContain('resolveRehearsalRateFingerprint')
    expect(journey).toContain('DELETE FROM listing_submission_rate_limits WHERE fingerprint_hash=?')
    expect(journey).not.toContain('generatedRateFingerprints')
  })

  it('derives sealed evidence from measured D1 and journey artifacts', () => {
    const source = readFileSync('scripts/d1-preview-evidence.ts', 'utf8')
    expect(source).toContain("required(values, '--measurement')")
    expect(source).toContain("required(values, '--source-controlled')")
    expect(source).toContain("required(values, '--source-classification')")
    expect(source).toContain("required(values, '--source-repeat-import')")
    expect(source).toContain("required(values, '--submission-journeys')")
    expect(source).toContain("required(values, '--post-journey-measurement')")
    expect(source).not.toMatch(
      /exactParity:\s*true|freshMigrationLedger:\s*true|nothingDeleted:\s*true/u
    )
    expect(source).not.toMatch(/copiedProduction:\s*\{[^}]*:\s*0/u)
  })

  it('reuses a still-valid authority token for positive-before and negative-after probes', () => {
    const source = readFileSync('scripts/d1-preview-authority-probe.ts', 'utf8')
    expect(source).toContain('BADGE_VERIFIER_USER_AGENT')
    expect(source).toContain('beforeBadgeStatus !== 200')
    expect(source).toContain('beforeAttestationStatus !== 200')
    expect(source).toContain('afterBadgeStatus !== 404')
    expect(source).toContain('afterAttestationStatus !== 404')
    expect(source).toContain('expired before negative verification')
  })
})
