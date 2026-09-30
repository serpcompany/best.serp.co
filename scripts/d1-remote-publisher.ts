import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCutoverUnlockedPlan,
  CutoverFrozenError,
  hasActiveCutoverLock,
  selectActiveCutoverLockPlan
} from '@serpdirectory/data-ops/cutover-lock'
import { buildPublicationPlan, type PlannedStatement, parseManifest } from './d1-publisher.ts'
import { resolveSiteTarget, type SiteTarget } from './site-targets'

interface D1ApiResult {
  results?: Array<Record<string, unknown>>
  success?: boolean
}

interface D1ApiResponse {
  errors?: Array<{ message?: string }>
  result?: D1ApiResult[]
  success?: boolean
}

type FetchImplementation = typeof fetch

function asPublicationStatement(plan: { params: unknown[]; sql: string }): PlannedStatement {
  return { bindings: plan.params, query: plan.sql }
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

function validatePublicationContext(
  manifestPath: string,
  target: SiteTarget,
  env: NodeJS.ProcessEnv
): string {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true')
    throw new Error('Remote publication requires GitHub Actions.')
  if (!env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/publish-d1.yml@'))
    throw new Error('Remote publication requires publish-d1.yml.')
  if (env.GITHUB_REF !== 'refs/heads/main' || !env.GITHUB_SHA)
    throw new Error('Remote publication requires reviewed main.')
  if (env.D1_PUBLICATION_CONFIRM !== target.confirmation.publish)
    throw new Error('Explicit production publication confirmation is required.')
  if (env.DEPLOY_SITE_ID !== target.siteId)
    throw new Error('Publication workflow site does not match the manifest site.')
  const resolvedPath = resolve(manifestPath)
  const publicationsDirectory = resolve('d1/publications')
  const pathWithinPublications = relative(publicationsDirectory, resolvedPath)
  if (
    pathWithinPublications.startsWith('..') ||
    resolve(publicationsDirectory, pathWithinPublications) !== resolvedPath
  ) {
    throw new Error('Publication manifests must be checked in under d1/publications.')
  }
  if (!resolvedPath.endsWith('.yaml') && !resolvedPath.endsWith('.yml'))
    throw new Error('Publication manifest must be YAML.')
  return resolvedPath
}

async function queryD1(
  statements: PlannedStatement[],
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation
): Promise<D1ApiResult[]> {
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const databaseId = requireEnvironment(env, 'CLOUDFLARE_D1_PRODUCTION_DATABASE_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const response = await fetchImplementation(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      body: JSON.stringify({
        batch: statements.map(statement => ({ sql: statement.query, params: statement.bindings }))
      }),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      method: 'POST'
    }
  )
  const payload = (await response.json()) as D1ApiResponse
  const errorMessage = payload.errors
    ?.map(error => error.message)
    .filter(Boolean)
    .join('; ')
  if (
    !response.ok ||
    payload.success === false ||
    !payload.result ||
    payload.result.some(result => result.success === false)
  ) {
    throw new Error(errorMessage || `D1 API query failed with status ${response.status}.`)
  }
  return payload.result
}

export async function publishRemoteManifest(
  manifestPath: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch
): Promise<{ afterChecksum: string; idempotent: boolean }> {
  const unresolvedPath = resolve(manifestPath)
  const source = readFileSync(unresolvedPath, 'utf8')
  const manifest = parseManifest(source)
  const target = resolveSiteTarget(manifest.siteId)
  const resolvedPath = validatePublicationContext(manifestPath, target, env)
  if (resolvedPath !== unresolvedPath)
    throw new Error('Manifest path resolution changed unexpectedly.')
  const plan = buildPublicationPlan(manifest, source, new Date().toISOString())
  async function throwIfLocked(): Promise<void> {
    const selected = await queryD1(
      [asPublicationStatement(selectActiveCutoverLockPlan(manifest.siteId))],
      env,
      fetchImplementation
    )
    if (hasActiveCutoverLock(selected[0]?.results ?? [])) throw new CutoverFrozenError()
  }
  await throwIfLocked()
  const prior = await queryD1(
    [
      {
        query:
          'SELECT outcome,input_checksum,after_checksum FROM publication_runs WHERE site_id=? AND manifest_id=?',
        bindings: [manifest.siteId, manifest.id]
      }
    ],
    env,
    fetchImplementation
  )
  const priorRow = prior[0]?.results?.[0]
  if (priorRow?.outcome === 'succeeded') {
    if (
      priorRow.input_checksum !== plan.inputChecksum ||
      priorRow.after_checksum !== plan.afterChecksum
    ) {
      throw new Error('Publication manifest ID was already used by different content.')
    }
    return { afterChecksum: plan.afterChecksum, idempotent: true }
  }

  try {
    await queryD1(plan.statements, env, fetchImplementation)
  } catch (error) {
    await throwIfLocked()
    const message = error instanceof Error ? error.message : String(error)
    await queryD1(
      [
        asPublicationStatement(assertCutoverUnlockedPlan(manifest.siteId)),
        {
          query:
            "INSERT INTO publication_runs (id,site_id,manifest_id,base_version,input_checksum,outcome,error,started_at,completed_at,actor,workflow,before_checksum,after_checksum) VALUES (?,?,?,?,?,'failed',?,?,?,?,?,?,?) ON CONFLICT(site_id,manifest_id) DO UPDATE SET outcome='failed',error=excluded.error,completed_at=excluded.completed_at",
          bindings: [
            `publish_failure_${manifest.id}`.slice(0, 64),
            manifest.siteId,
            manifest.id,
            manifest.basePublicationVersion,
            plan.inputChecksum,
            message.slice(0, 1000),
            new Date().toISOString(),
            new Date().toISOString(),
            manifest.provenance.actor,
            manifest.provenance.workflow,
            manifest.provenance.beforeChecksum,
            plan.afterChecksum
          ]
        }
      ],
      env,
      fetchImplementation
    )
    throw error
  }

  return { afterChecksum: plan.afterChecksum, idempotent: false }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const manifestPath = process.argv[2]
  if (!manifestPath)
    throw new Error('Usage: pnpm d1:publish:production -- d1/publications/<manifest>.yaml')
  console.log(JSON.stringify(await publishRemoteManifest(manifestPath)))
}
