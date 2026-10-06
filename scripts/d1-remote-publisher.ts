import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPublicationPlan,
  type PlannedStatement,
  type PublicationManifest,
  parseManifest
} from './d1-publisher.ts'
import { project } from './project'

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

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

export type PublicationTarget = 'production' | 'staging'

/**
 * Where each target may publish from (#95): staging from `staging` through
 * `publish-d1-staging.yml`, production from `main` through `publish-d1.yml`, each with its own
 * typed confirmation, so every reviewed manifest is applied to staging before production.
 */
export const publicationTargets: Readonly<
  Record<
    PublicationTarget,
    { branch: string; confirmation: string; workflow: string; workflowRef: string }
  >
> = {
  production: {
    branch: 'main',
    confirmation: project.confirmation.publish,
    workflow: 'publish-d1.yml',
    workflowRef: '/.github/workflows/publish-d1.yml@'
  },
  staging: {
    branch: 'staging',
    confirmation: project.confirmation.publishStaging,
    workflow: 'publish-d1-staging.yml',
    workflowRef: '/.github/workflows/publish-d1-staging.yml@'
  }
}

function validatePublicationContext(
  manifestPath: string,
  env: NodeJS.ProcessEnv,
  target: PublicationTarget
): string {
  const { branch, confirmation, workflow, workflowRef } = publicationTargets[target]
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true')
    throw new Error('Remote publication requires GitHub Actions.')
  if (!env.GITHUB_WORKFLOW_REF?.includes(workflowRef))
    throw new Error(`Remote publication to ${target} requires ${workflow}.`)
  if (env.GITHUB_REF !== `refs/heads/${branch}` || !env.GITHUB_SHA)
    throw new Error(`Remote publication to ${target} requires reviewed ${branch}.`)
  if (env.D1_PUBLICATION_CONFIRM !== confirmation)
    throw new Error(`Explicit ${target} publication confirmation ${confirmation} is required.`)
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
  const databaseId = requireEnvironment(env, 'CLOUDFLARE_D1_DATABASE_ID')
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

/**
 * Refuses a manifest whose hosted media the target's media host does not serve yet (#95): its
 * upload plan must run first, so a page never names a key that answers 404.
 */
export async function assertHostedMediaServed(
  manifest: PublicationManifest,
  target: PublicationTarget,
  fetchImplementation: FetchImplementation
): Promise<void> {
  const images = manifest.operations.flatMap(op =>
    op.action === 'listing-media-update'
      ? [...(op.media.logo ? [op.media.logo] : []), ...(op.media.images ?? [])]
      : []
  )
  const baseUrl = project.remote[target].media.baseUrl
  const missing: string[] = []
  const queue = [...images]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let image = queue.shift(); image; image = queue.shift()) {
        let served = false
        try {
          const response = await fetchImplementation(`${baseUrl}/${image.key}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(15_000)
          })
          served = response.ok && Number(response.headers.get('content-length')) === image.bytes
        } catch {
          served = false
        }
        if (!served) missing.push(image.key)
      }
    })
  )
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} hosted media keys are not on ${baseUrl} yet (first: ${missing.sort()[0]}). Run the media upload for this plan first.`
    )
  }
}

export async function publishRemoteManifest(
  manifestPath: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
  target: PublicationTarget = 'production'
): Promise<{ afterChecksum: string; idempotent: boolean }> {
  const unresolvedPath = resolve(manifestPath)
  const source = readFileSync(unresolvedPath, 'utf8')
  const manifest = parseManifest(source)
  const resolvedPath = validatePublicationContext(manifestPath, env, target)
  if (resolvedPath !== unresolvedPath)
    throw new Error('Manifest path resolution changed unexpectedly.')
  const plan = buildPublicationPlan(manifest, source, new Date().toISOString())
  await assertHostedMediaServed(manifest, target, fetchImplementation)
  const prior = await queryD1(
    [
      {
        query:
          'SELECT outcome,input_checksum,after_checksum FROM publication_runs WHERE manifest_id=?',
        bindings: [manifest.id]
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
    const message = error instanceof Error ? error.message : String(error)
    await queryD1(
      [
        {
          query:
            "INSERT INTO publication_runs (id,manifest_id,base_version,input_checksum,outcome,error,started_at,completed_at,actor,workflow,before_checksum,after_checksum) VALUES (?,?,?,?,'failed',?,?,?,?,?,?,?) ON CONFLICT(manifest_id) DO UPDATE SET outcome='failed',error=excluded.error,completed_at=excluded.completed_at",
          bindings: [
            `publish_failure_${manifest.id}`.slice(0, 64),
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

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(value => value !== '--')
  const target: PublicationTarget = args[0] === '--staging' ? 'staging' : 'production'
  const [manifestPath] = args.filter(value => value !== '--staging')
  if (!manifestPath)
    throw new Error(
      'Usage: pnpm db:publish:<staging|production> -- d1/publications/<manifest>.yaml'
    )
  console.log(JSON.stringify(await publishRemoteManifest(manifestPath, process.env, fetch, target)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
