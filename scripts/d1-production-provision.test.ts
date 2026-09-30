import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  parseCloudflareHttpFailure,
  type ReplacementProvisionDependencies
} from './d1-database-provision'
import { provisionReplacementProduction } from './d1-production-provision'
import { type SiteId, siteIds, siteTargets } from './site-targets'

const sourceId = '11111111-1111-4111-8111-111111111111'
const replacementId = '22222222-2222-4222-8222-222222222222'
const accountId = 'a'.repeat(32)
const sha = 'b'.repeat(40)

function sourceName(siteId: SiteId): string {
  return siteId === 'serp.software' ? 'serp-software' : 'pornvideodownloaders'
}

function workerName(siteId: SiteId): string {
  return siteId === 'serp.software' ? 'serp-software' : 'pornvideodownloaders'
}

function envelope(result: unknown) {
  return { result, success: true }
}

function workflowEnvironment(siteId: SiteId, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const target = siteTargets[siteId]
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF:
      'owner/repo/.github/workflows/provision-d1-replacement-production.yml@refs/heads/main',
    D1_PRODUCTION_PROVISION_CONFIRM: target.replatform.productionProvisioningConfirmation,
    D1_PROTECTED_ENVIRONMENT: target.protectedEnvironment.production,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_EXPECTED_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: 'masked-token',
    CLOUDFLARE_D1_PRODUCTION_DATABASE_ID: sourceId,
    CLOUDFLARE_D1_PRODUCTION_DATABASE_NAME: sourceName(siteId),
    CLOUDFLARE_D1_PRODUCTION_PLACEMENT: 'region:apac',
    CLOUDFLARE_WORKER_PRODUCTION_NAME: workerName(siteId),
    ...overrides
  }
}

function dependencies(
  siteId: SiteId,
  options: { existing?: boolean; sourceJurisdiction?: string } = {}
) {
  const replacementName = siteTargets[siteId].replatform.productionDatabaseName
  const events: string[] = []
  let databases = [
    { name: sourceName(siteId), uuid: sourceId },
    ...(options.existing ? [{ name: replacementName, uuid: replacementId }] : [])
  ]
  const deps: ReplacementProvisionDependencies = {
    async createDatabase(_account, _token, body) {
      events.push(`create:${JSON.stringify(body)}`)
      const created = { jurisdiction: body.jurisdiction, name: body.name, uuid: replacementId }
      databases = [...databases, created]
      return envelope(created)
    },
    async fetchAccount() {
      events.push('account')
      return envelope({ id: accountId })
    },
    async fetchDatabase(_account, id) {
      events.push(`database:${id}`)
      const found = databases.find(item => item.uuid === id)
      if (!found) throw new Error('missing fixture database')
      return envelope({
        ...found,
        ...(id === sourceId && options.sourceJurisdiction
          ? { jurisdiction: options.sourceJurisdiction }
          : {})
      })
    },
    async fetchDatabases() {
      events.push('databases')
      return databases
    },
    async fetchToken() {
      events.push('token')
      return envelope({ id: 'api-token-id', status: 'active' })
    },
    async fetchUser() {
      events.push('user')
      return envelope({ email: 'maintainer@example.com', id: 'oauth-user-id' })
    },
    async fetchWorker() {
      events.push('worker')
      return envelope({ name: workerName(siteId) })
    },
    readGit(command) {
      return command === 'head' ? sha : ''
    },
    now: () => '2026-09-25T00:00:00.000Z'
  }
  return { deps, events }
}

describe.each(siteIds)('%s replacement Production D1 provisioning', siteId => {
  it('proves the protected identities and creates exactly one empty named D1', async () => {
    const { deps, events } = dependencies(siteId)
    const evidence = await provisionReplacementProduction(siteId, workflowEnvironment(siteId), deps)

    expect(evidence).toMatchObject({
      action: 'created',
      accountId,
      commitSha: sha,
      credentialIdentity: 'api-token',
      environment: 'production',
      protectedEnvironment: siteTargets[siteId].protectedEnvironment.production,
      replacement: {
        jurisdiction: null,
        name: siteTargets[siteId].replatform.productionDatabaseName,
        region: 'apac',
        uuid: replacementId
      },
      siteId,
      source: { name: sourceName(siteId), region: 'apac', uuid: sourceId },
      verifiedWorkerName: workerName(siteId)
    })
    expect(events.filter(item => item.startsWith('create:'))).toEqual([
      `create:${JSON.stringify({
        name: siteTargets[siteId].replatform.productionDatabaseName,
        primary_location_hint: 'apac'
      })}`
    ])
    expect(events.indexOf('token')).toBeLessThan(events.indexOf('account'))
    expect(events.indexOf('account')).toBeLessThan(events.indexOf('worker'))
    expect(events.indexOf('worker')).toBeLessThan(
      events.findIndex(item => item.startsWith('create:'))
    )
    expect(events).not.toContain('user')
    expect(JSON.stringify(evidence)).not.toContain('masked-token')
  })

  it('records the created UUID before post-create verification can fail', async () => {
    const { deps, events } = dependencies(siteId)
    const fetchDatabases = deps.fetchDatabases
    let listCalls = 0
    deps.fetchDatabases = async (...args) => {
      listCalls += 1
      if (listCalls === 2) throw new Error('simulated post-create read-back outage')
      return fetchDatabases(...args)
    }
    const receipts: Array<Record<string, unknown>> = []

    await expect(
      provisionReplacementProduction(siteId, workflowEnvironment(siteId), deps, receipt =>
        receipts.push(receipt)
      )
    ).rejects.toThrow('simulated post-create read-back outage')

    expect(events.filter(item => item.startsWith('create:'))).toHaveLength(1)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      action: 'created-pending-verification',
      replacement: {
        name: siteTargets[siteId].replatform.productionDatabaseName,
        uuid: replacementId
      },
      siteId
    })
    expect(JSON.stringify(receipts[0])).not.toContain('masked-token')
  })

  it('accepts only the exact Wrangler OAuth fallback before any resource read', async () => {
    const { deps, events } = dependencies(siteId)
    deps.fetchToken = async () => {
      events.push('token')
      throw parseCloudflareHttpFailure(401, {
        errors: [{ code: 1000, message: 'Invalid API Token' }],
        result: null,
        success: false
      })
    }
    const evidence = await provisionReplacementProduction(siteId, workflowEnvironment(siteId), deps)
    expect(evidence).toMatchObject({ credentialIdentity: 'wrangler-oauth' })
    expect(events.slice(0, 3)).toEqual(['token', 'user', 'account'])

    const rejected = dependencies(siteId)
    rejected.deps.fetchToken = async () => {
      rejected.events.push('token')
      throw parseCloudflareHttpFailure(401, {
        errors: [{ code: 1001, message: 'Invalid API Token' }],
        result: null,
        success: false
      })
    }
    await expect(
      provisionReplacementProduction(siteId, workflowEnvironment(siteId), rejected.deps)
    ).rejects.toThrow()
    expect(rejected.events).toEqual(['token'])
  })

  it('copies an observed jurisdiction and rejects contradictory protected placement', async () => {
    const exact = dependencies(siteId, { sourceJurisdiction: 'eu' })
    const evidence = await provisionReplacementProduction(
      siteId,
      workflowEnvironment(siteId, { CLOUDFLARE_D1_PRODUCTION_PLACEMENT: 'jurisdiction:eu' }),
      exact.deps
    )
    expect(evidence.replacement).toMatchObject({ jurisdiction: 'eu', region: null })
    expect(exact.events.filter(item => item.startsWith('create:'))).toEqual([
      `create:${JSON.stringify({
        name: siteTargets[siteId].replatform.productionDatabaseName,
        jurisdiction: 'eu'
      })}`
    ])

    const contradictory = dependencies(siteId, { sourceJurisdiction: 'eu' })
    await expect(
      provisionReplacementProduction(
        siteId,
        workflowEnvironment(siteId, { CLOUDFLARE_D1_PRODUCTION_PLACEMENT: 'region:apac' }),
        contradictory.deps
      )
    ).rejects.toThrow('does not match the observed D1 jurisdiction')
    expect(contradictory.events.some(item => item.startsWith('create:'))).toBe(false)
  })

  it('makes an exact configured rerun read-only', async () => {
    const { deps, events } = dependencies(siteId, { existing: true })
    const evidence = await provisionReplacementProduction(
      siteId,
      workflowEnvironment(siteId, {
        CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: replacementId,
        CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME:
          siteTargets[siteId].replatform.productionDatabaseName
      }),
      deps
    )
    expect(evidence).toMatchObject({
      action: 'verified-existing',
      replacement: { uuid: replacementId }
    })
    expect(events.some(item => item.startsWith('create:'))).toBe(false)
  })

  it('fails before remote access for the wrong ref, workflow, environment, or confirmation', async () => {
    const cases: NodeJS.ProcessEnv[] = [
      { GITHUB_REF: 'refs/heads/topic' },
      { GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
      { D1_PROTECTED_ENVIRONMENT: 'wrong-environment' },
      { D1_PRODUCTION_PROVISION_CONFIRM: 'provision-wrong-replacement-production' }
    ]
    for (const overrides of cases) {
      const { deps, events } = dependencies(siteId)
      await expect(
        provisionReplacementProduction(siteId, workflowEnvironment(siteId, overrides), deps)
      ).rejects.toThrow()
      expect(events).toEqual([])
    }
  })

  it('rejects partial, aliased, missing, or unexpected same-name replacement identity', async () => {
    const partial = dependencies(siteId)
    await expect(
      provisionReplacementProduction(
        siteId,
        workflowEnvironment(siteId, {
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: replacementId
        }),
        partial.deps
      )
    ).rejects.toThrow('both absent or both present')

    const alias = dependencies(siteId)
    await expect(
      provisionReplacementProduction(
        siteId,
        workflowEnvironment(siteId, {
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: sourceId,
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME:
            siteTargets[siteId].replatform.productionDatabaseName
        }),
        alias.deps
      )
    ).rejects.toThrow('IDs must be distinct')

    const missing = dependencies(siteId)
    await expect(
      provisionReplacementProduction(
        siteId,
        workflowEnvironment(siteId, {
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: replacementId,
          CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME:
            siteTargets[siteId].replatform.productionDatabaseName
        }),
        missing.deps
      )
    ).rejects.toThrow('configured but is not present')

    const unexpected = dependencies(siteId, { existing: true })
    await expect(
      provisionReplacementProduction(siteId, workflowEnvironment(siteId), unexpected.deps)
    ).rejects.toThrow('configure its exact protected ID and name')
    expect(
      [...partial.events, ...alias.events, ...missing.events, ...unexpected.events].some(item =>
        item.startsWith('create:')
      )
    ).toBe(false)
  })
})

describe('replacement Production provisioning workflow contract', () => {
  it('is exact-main, Site-explicit, protected, serialized, and limited to one D1 create boundary', () => {
    const raw = readFileSync('.github/workflows/provision-d1-replacement-production.yml', 'utf8')
    const workflow = yaml.load(raw) as {
      concurrency: { group: string }
      jobs: {
        provision: { environment: { name: string }; if: string; steps: Array<{ run?: string }> }
      }
      on: {
        workflow_dispatch: {
          inputs: { confirmation: { required: boolean }; site_id: { options: string[] } }
        }
      }
      permissions: Record<string, string>
    }
    const job = workflow.jobs.provision
    const commands = job.steps.map(step => step.run ?? '').join('\n')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.on.workflow_dispatch.inputs.site_id.options).toEqual([...siteIds])
    expect(workflow.on.workflow_dispatch.inputs.confirmation.required).toBe(true)
    expect(workflow.concurrency.group).toBe('$' + '{{ inputs.site_id }}-production-d1')
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).toContain(
      "inputs.confirmation == format('provision-{0}-replacement-production', inputs.site_id)"
    )
    expect(job.environment.name).toContain('pornvideodownloaders-production')
    expect(job.environment.name).toContain("|| 'production'")
    expect(commands).toContain('scripts/d1-production-provision.ts')
    expect(commands).toContain('--site "$' + '{{ inputs.site_id }}"')
    expect(raw).toContain(
      'CLOUDFLARE_D1_PRODUCTION_PLACEMENT: $' + '{{ vars.CLOUDFLARE_D1_PRODUCTION_PLACEMENT }}'
    )
    expect(raw).toContain('if: always()')
    expect(commands).not.toMatch(
      /worker-release|wrangler|d1\s+(?:execute|migrations|delete)|gh secret|deploy|cutover|finalize/iu
    )
    expect(raw).not.toContain('CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID: ${{ vars.')
  })

  it('derives each replacement name and confirmation from the registry and template contract', () => {
    for (const siteId of siteIds) {
      const target = siteTargets[siteId]
      expect(target.replatform.productionProvisioningConfirmation).toBe(
        `provision-${siteId}-replacement-production`
      )
      expect(target.replatform.productionDatabaseName).toMatch(/-replatform-production$/u)
      const template = readFileSync(target.replatform.productionConfigPath, 'utf8')
      expect(template).toContain('$' + '{CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME}')
      expect(template).toContain('$' + '{CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID}')
      expect(template).not.toContain(replacementId)
    }
  })
})
