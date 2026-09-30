import { describe, expect, it, vi } from 'vitest'
import {
  type RoutinePreviewIdentityDependencies,
  verifyRoutinePreviewIdentity
} from './d1-routine-preview-identity'
import { siteTargets } from './site-targets'

const serp = siteTargets['serp.software']
const baseEnv = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF:
    'serpcompany/directory-platform-d1/.github/workflows/build-and-deploy.yml@refs/heads/main',
  WORKER_PRODUCTION_CONFIRM: serp.confirmation.deploy.preview,
  D1_RELEASE_GENERATION: 'replatform',
  CLOUDFLARE_ACCOUNT_ID: serp.activePreview.accountId,
  CLOUDFLARE_API_TOKEN: 'test-token',
  CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: serp.activePreview.databaseId,
  CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: serp.activePreview.databaseName,
  CLOUDFLARE_WORKER_PREVIEW_NAME: serp.activePreview.workerName
}

function envelope(result: Record<string, unknown>): unknown {
  return { result, success: true }
}

function dependencies(
  overrides: Partial<RoutinePreviewIdentityDependencies> = {}
): RoutinePreviewIdentityDependencies & {
  fetchAccount: ReturnType<typeof vi.fn>
  fetchDatabase: ReturnType<typeof vi.fn>
  fetchWorker: ReturnType<typeof vi.fn>
} {
  return {
    fetchAccount: vi.fn(async () => envelope({ id: serp.activePreview.accountId })),
    fetchDatabase: vi.fn(async () =>
      envelope({
        name: serp.activePreview.databaseName,
        uuid: serp.activePreview.databaseId
      })
    ),
    fetchWorker: vi.fn(async () => envelope({ name: serp.activePreview.workerName })),
    ...overrides
  }
}

describe('routine Preview observed identity gate', () => {
  it('pins the reviewed active SERP Preview identity from the cutover record', () => {
    expect(serp.activePreview).toEqual({
      accountId: 'cec5f04e1d18bcc65f2be0aefb04f059',
      databaseId: '29c0a6ed-e824-459c-b088-6098fdbf1abf',
      databaseName: 'serp-software-replatform-preview',
      workerName: 'serp-software-replatform-preview'
    })
  })

  it('observes the exact checked-in active SERP account, D1, and Worker read-only', async () => {
    const api = dependencies()
    await expect(verifyRoutinePreviewIdentity('serp.software', baseEnv, api)).resolves.toEqual({
      ...serp.activePreview,
      environment: 'preview',
      siteId: 'serp.software'
    })
    expect(api.fetchAccount).toHaveBeenCalledWith(serp.activePreview.accountId, 'test-token')
    expect(api.fetchDatabase).toHaveBeenCalledWith(
      serp.activePreview.accountId,
      serp.activePreview.databaseId,
      'test-token'
    )
    expect(api.fetchWorker).toHaveBeenCalledWith(
      serp.activePreview.accountId,
      serp.activePreview.workerName,
      'test-token'
    )
  })

  it.each([
    ['wrong account', { CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000' }],
    [
      'deleted retained-source Preview',
      {
        CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: '5e96a9f0-e11a-4c60-8dd3-02299c032466',
        CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: 'serp-software-replatform-source-preview'
      }
    ],
    [
      'SERP Production',
      {
        CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: '7d525a45-318b-4227-9463-19f4e9cb6eb6',
        CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: 'serp-software-replatform-production',
        CLOUDFLARE_WORKER_PREVIEW_NAME: 'serp-software-production'
      }
    ],
    [
      'PVD Preview',
      {
        CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID: '16ede356-3caa-4cea-93f3-69f5b208b1d7',
        CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME: 'pornvideodownloaders-replatform-preview',
        CLOUDFLARE_WORKER_PREVIEW_NAME: 'pornvideodownloaders-preview'
      }
    ]
  ])('rejects %s protected values before any Cloudflare request', async (_label, changed) => {
    const api = dependencies()
    await expect(
      verifyRoutinePreviewIdentity('serp.software', { ...baseEnv, ...changed }, api)
    ).rejects.toThrow('do not select the checked-in active identity')
    expect(api.fetchAccount).not.toHaveBeenCalled()
    expect(api.fetchDatabase).not.toHaveBeenCalled()
    expect(api.fetchWorker).not.toHaveBeenCalled()
  })

  it('fails closed on stale observed D1 identity before observing the Worker', async () => {
    const api = dependencies({
      fetchDatabase: vi.fn(async () =>
        envelope({
          name: 'serp-software-replatform-source-preview',
          uuid: '5e96a9f0-e11a-4c60-8dd3-02299c032466'
        })
      )
    })
    await expect(verifyRoutinePreviewIdentity('serp.software', baseEnv, api)).rejects.toThrow(
      'does not match the checked-in active Preview database'
    )
    expect(api.fetchWorker).not.toHaveBeenCalled()
  })

  it('fails closed on observed Production or PVD Worker identity', async () => {
    for (const workerName of ['serp-software-production', 'pornvideodownloaders-preview']) {
      const api = dependencies({
        fetchWorker: vi.fn(async () => envelope({ name: workerName }))
      })
      await expect(verifyRoutinePreviewIdentity('serp.software', baseEnv, api)).rejects.toThrow(
        'does not match the checked-in active Preview Worker'
      )
    }
  })

  it('rejects a non-main, wrong-workflow, legacy-generation, or unconfirmed context', async () => {
    for (const changed of [
      { GITHUB_REF: 'refs/heads/topic' },
      {
        GITHUB_WORKFLOW_REF:
          'serpcompany/directory-platform-d1/.github/workflows/deploy-pornvideodownloaders.yml@refs/heads/main'
      },
      { D1_RELEASE_GENERATION: 'legacy' },
      { WORKER_PRODUCTION_CONFIRM: 'deploy-serp.software-production' }
    ]) {
      const api = dependencies()
      await expect(
        verifyRoutinePreviewIdentity('serp.software', { ...baseEnv, ...changed }, api)
      ).rejects.toThrow('exact protected main workflow')
      expect(api.fetchAccount).not.toHaveBeenCalled()
    }
  })
})
