import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEDIA_CACHE_CONTROL, MEDIA_SITE } from '@serpdirectory/data-ops/media-keys'
import { validateRemoteConfig } from './cloudflare-release'
import { assertD1Compatible } from './d1-compat'
import {
  buildPublicationPlan,
  CURRENT_MEDIA_JSON,
  expectedMediaJson,
  type PlannedStatement,
  type PublicationBase,
  type PublicationManifest,
  parseManifest
} from './d1-publisher.ts'
import { type MediaPlanObject, mediaPlanSchema, verifyObject } from './media-upload'
import { project } from './project'
import { describeFetchError, getR2Object, listedMismatch, listR2Objects } from './r2-objects'

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
  assertD1Compatible(statements)
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
    // A publication guard refuses the batch by raising `malformed JSON` (`GUARD_FAILURE`).
    if (errorMessage && /malformed JSON/iu.test(errorMessage)) {
      throw new Error(
        `A publication guard refused the batch (${errorMessage}): the publication version or a listing row is not what the manifest expects. Nothing was written.`
      )
    }
    throw new Error(errorMessage || `D1 API query failed with status ${response.status}.`)
  }
  return payload.result
}

/**
 * Ties the run to its target's database (#97 review B4): `CLOUDFLARE_D1_DATABASE_ID` must be the
 * target's ID in `scripts/project.ts`, which `wrangler.jsonc` must still match
 * (`validateRemoteConfig`), and Cloudflare must name that database as the target's, read through
 * the API before anything is written. A staging run can then never write to production D1, nor
 * the other way round, whatever its workflow sets.
 */
export async function verifyTargetDatabase(
  env: NodeJS.ProcessEnv,
  target: PublicationTarget,
  fetchImplementation: FetchImplementation,
  configPath: string = project.wranglerConfigPath
): Promise<void> {
  const expected = project.remote[target]
  const databaseId = requireEnvironment(env, 'CLOUDFLARE_D1_DATABASE_ID')
  if (databaseId !== expected.databaseId) {
    throw new Error(
      `CLOUDFLARE_D1_DATABASE_ID is not the ${target} database ${expected.databaseName} (${expected.databaseId}).`
    )
  }
  validateRemoteConfig(target, configPath)
  const accountId = requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
  const apiToken = requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  const response = await fetchImplementation(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`,
    { headers: { Authorization: `Bearer ${apiToken}` }, method: 'GET' }
  )
  const payload = (await response.json().catch(() => null)) as {
    result?: { name?: string; uuid?: string }
    success?: boolean
  } | null
  const name = payload?.result?.name
  if (!response.ok || payload?.success === false || name !== expected.databaseName) {
    throw new Error(
      `Cloudflare names database ${databaseId} ${name ?? '(unreadable)'}, not ${expected.databaseName}; refusing to publish to ${target}.`
    )
  }
}

function mediaUpdates(manifest: PublicationManifest) {
  return manifest.operations.flatMap(op => (op.action === 'listing-media-update' ? [op] : []))
}

/** The reviewed upload plans' objects by key (`d1/media/*.json`), for their MD5. */
export function reviewedPlanObjects(directory = resolve('d1/media')): Map<string, MediaPlanObject> {
  const objects = new Map<string, MediaPlanObject>()
  for (const file of readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()) {
    const parsed = mediaPlanSchema.safeParse(
      JSON.parse(readFileSync(join(directory, file), 'utf8'))
    )
    if (!parsed.success) continue
    for (const object of parsed.data.objects) objects.set(object.key, object)
  }
  return objects
}

/**
 * Refuses a manifest whose hosted media the target's bucket does not hold yet, byte for byte
 * (#95; #97 review S4): its upload plan must run first, so a page never names a key that
 * answers 404 or serves other bytes. The target's own bucket is listed through the R2 API (never
 * a CDN), and each object is verified by size, type, cache policy, and its ETag, the MD5 R2
 * computed from the stored bytes, against the reviewed plan that pins the same bytes' MD5 and
 * SHA-256 (#95 release blocker 3: a GET per object spent the API rate limit). An image no plan
 * describes is read back and verified like an upload (`verifyObject`).
 */
export async function assertHostedMediaServed(
  manifest: PublicationManifest,
  target: PublicationTarget,
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
  plans: Map<string, MediaPlanObject> = reviewedPlanObjects()
): Promise<void> {
  const images = mediaUpdates(manifest).flatMap(op => [
    ...(op.media.logo ? [op.media.logo] : []),
    ...(op.media.images ?? [])
  ])
  if (images.length === 0) return
  const { bucket } = project.remote[target].media
  const listed = await listR2Objects(bucket, `${MEDIA_SITE}/listings/`, env, fetchImplementation)
  const problems: string[] = []
  for (const image of new Map(images.map(entry => [entry.key, entry])).values()) {
    let problem: string | null
    const stored = listed.get(image.key)
    const planned = plans.get(image.key)
    const samePlan =
      planned &&
      planned.sha256 === image.sha256 &&
      planned.bytes === image.bytes &&
      planned.contentType === image.contentType &&
      planned.width === image.width &&
      planned.height === image.height
    if (!stored) problem = 'missing'
    else if (samePlan) problem = listedMismatch(planned, stored, MEDIA_CACHE_CONTROL)
    else {
      try {
        const body = await getR2Object(bucket, image.key, env, fetchImplementation)
        problem = body ? verifyObject(image, body) : 'missing'
      } catch (error) {
        problem = describeFetchError(error)
      }
    }
    if (problem) problems.push(`${image.key} (${problem})`)
  }
  if (problems.length > 0) {
    problems.sort()
    throw new Error(
      `${problems.length} hosted media objects are not in the ${bucket} bucket as reviewed (first: ${problems[0]}). Run the media upload for this plan first.`
    )
  }
}

export interface MediaDrift {
  actual: string | null
  expected: string
  id: string
  slug: string
}

/**
 * A row-level manifest's preflight (#97 review B3): every listing it repoints must still exist
 * under its slug with the logo and image rows the manifest expects. Nothing is written; a drifted
 * listing is reported so the manifest is regenerated from the current state.
 */
export async function mediaDrift(
  manifest: PublicationManifest,
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation
): Promise<MediaDrift[]> {
  const updates = mediaUpdates(manifest)
  const drift: MediaDrift[] = []
  for (let start = 0; start < updates.length; start += 50) {
    const chunk = updates.slice(start, start + 50)
    const [result] = await queryD1(
      [
        {
          query: `SELECT l.id,l.slug,${CURRENT_MEDIA_JSON.replace('listing_id=?', 'listing_id=l.id')} AS media FROM listings l WHERE l.id IN (${chunk.map(() => '?').join(',')})`,
          bindings: chunk.map(op => op.id)
        }
      ],
      env,
      fetchImplementation
    )
    const rows = new Map(
      (result?.results ?? []).map(row => [String(row.id), row as Record<string, unknown>])
    )
    for (const op of chunk) {
      const row = rows.get(op.id)
      const expected = expectedMediaJson(op.expected)
      const actual = row && row.slug === op.slug ? String(row.media) : null
      if (actual !== expected) drift.push({ actual, expected, id: op.id, slug: op.slug })
    }
  }
  return drift
}

async function readPublicationState(
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation
): Promise<PublicationBase> {
  const [result] = await queryD1(
    [{ query: 'SELECT version,checksum FROM publication_state WHERE id=1', bindings: [] }],
    env,
    fetchImplementation
  )
  const row = result?.results?.[0]
  if (!row) throw new Error('The target database has no publication state.')
  return { checksum: String(row.checksum), version: Number(row.version) }
}

/** Publishes a row-level manifest at most this many times while other writes move the version. */
const ROW_LEVEL_ATTEMPTS = 3

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
  const rowLevel = manifest.concurrency === 'rows'
  await verifyTargetDatabase(env, target, fetchImplementation)
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
  const inputChecksum = createHash('sha256').update(source).digest('hex')
  if (priorRow?.outcome === 'succeeded') {
    // A row-level manifest is the same publication when its input is (its base was read live).
    const planned = rowLevel
      ? null
      : buildPublicationPlan(manifest, source, new Date().toISOString())
    if (
      priorRow.input_checksum !== inputChecksum ||
      (planned && priorRow.after_checksum !== planned.afterChecksum)
    ) {
      throw new Error('Publication manifest ID was already used by different content.')
    }
    return { afterChecksum: String(priorRow.after_checksum), idempotent: true }
  }
  await assertHostedMediaServed(manifest, target, env, fetchImplementation)

  let lastError: unknown
  let plan = buildPublicationPlan(
    manifest,
    source,
    new Date().toISOString(),
    rowLevel ? await readPublicationState(env, fetchImplementation) : undefined
  )
  for (let attempt = 1; attempt <= (rowLevel ? ROW_LEVEL_ATTEMPTS : 1); attempt += 1) {
    if (rowLevel) {
      const drift = await mediaDrift(manifest, env, fetchImplementation)
      if (drift.length > 0) {
        const first = drift[0]
        throw new Error(
          `${drift.length} listings changed since this manifest was generated (first: ${first?.slug}, expected ${first?.expected}, found ${first?.actual ?? 'no such listing'}). Nothing was written. Regenerate the manifest from the current state and publish it again (docs/MEDIA.md#recovering-a-refused-media-manifest).`
        )
      }
    }
    try {
      await queryD1(plan.statements, env, fetchImplementation)
      return { afterChecksum: plan.afterChecksum, idempotent: false }
    } catch (error) {
      lastError = error
      if (!rowLevel || attempt === ROW_LEVEL_ATTEMPTS) break
      // Another write may have moved the version between the read and the batch; the rows are
      // checked again before the next attempt, against the state read now.
      const live = await readPublicationState(env, fetchImplementation)
      if (live.version === plan.base.version && live.checksum === plan.base.checksum) break
      plan = buildPublicationPlan(manifest, source, new Date().toISOString(), live)
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  await queryD1(
    [
      {
        query:
          "INSERT INTO publication_runs (id,manifest_id,base_version,input_checksum,outcome,error,started_at,completed_at,actor,workflow,before_checksum,after_checksum) VALUES (?,?,?,?,'failed',?,?,?,?,?,?,?) ON CONFLICT(manifest_id) DO UPDATE SET outcome='failed',error=excluded.error,completed_at=excluded.completed_at",
        bindings: [
          `publish_failure_${manifest.id}`.slice(0, 64),
          manifest.id,
          plan.base.version,
          plan.inputChecksum,
          message.slice(0, 1000),
          new Date().toISOString(),
          new Date().toISOString(),
          manifest.provenance.actor,
          manifest.provenance.workflow,
          plan.base.checksum,
          plan.afterChecksum
        ]
      }
    ],
    env,
    fetchImplementation
  )
  throw lastError
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
