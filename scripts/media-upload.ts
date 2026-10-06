import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_CONTENT_TYPES, sniffImage } from '@serpdirectory/data-ops/media-format'
import {
  contentTypeForKey,
  isListingMediaKey,
  MAX_MEDIA_BYTES,
  MEDIA_CACHE_CONTROL,
  MEDIA_HASH_LENGTH,
  MEDIA_SITE,
  parseMediaKey
} from '@serpdirectory/data-ops/media-keys'
import { safeFetch } from '@serpdirectory/data-ops/safe-fetch'
import { nodeFetch } from '@serpdirectory/data-ops/safe-fetch-node'
import { z } from 'zod'
import { project } from './project'
import { describeFetchError, getR2Object, putR2Object } from './r2-objects'

/**
 * Uploads a reviewed listing media plan (`d1/media/<id>.json`, serpcompany/best.serp.co#95) into
 * one environment's bucket. Only `upload-media-staging.yml` (from `staging`) and
 * `upload-media.yml` (from `main`) run it for real, after their environment's approval; agents
 * never write to staging or production R2. `--dry-run` fetches and verifies every source without
 * credentials and writes nothing.
 *
 * A staging upload fetches every object again from its recorded source (a public https URL
 * through `safeFetch` with the DNS-checked Node fetcher, or `repo:` a file checked in under
 * `apps/web/public`). A production upload copies the object from the staging bucket through the
 * R2 API instead (never through the CDN), so production gets exactly the bytes staging verified,
 * however the source changed since. Either way an object is uploaded only when its bytes,
 * SHA-256, format, and dimensions match the reviewed plan.
 *
 * An object already in the target bucket is read back through the R2 API and verified the same
 * way: a match is skipped (`present`), so a rerun only finishes what is missing; a mismatch fails
 * that key (`present_mismatch`) and is never overwritten, since something else wrote it (#97
 * review B2). Keys outside `best.serp.co/listings/` are refused: the production bucket is shared
 * with serp.co.
 */

export type UploadTarget = 'production' | 'staging'

export const uploadTargets: Readonly<
  Record<
    UploadTarget,
    {
      baseUrl: string
      branch: string
      bucket: string
      confirmation: string
      workflowRef: string
    }
  >
> = {
  production: {
    baseUrl: project.remote.production.media.baseUrl,
    branch: 'main',
    bucket: project.remote.production.media.bucket,
    confirmation: project.confirmation.mediaUpload,
    workflowRef: '/.github/workflows/upload-media.yml@'
  },
  staging: {
    baseUrl: project.remote.staging.media.baseUrl,
    branch: 'staging',
    bucket: project.remote.staging.media.bucket,
    confirmation: project.confirmation.mediaUploadStaging,
    workflowRef: '/.github/workflows/upload-media-staging.yml@'
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/u
const publicDirectory = resolve(project.appDirectory, 'public')

const planObject = z
  .object({
    bytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
    contentType: z.enum(Object.values(IMAGE_CONTENT_TYPES) as [string, ...string[]]),
    height: z.number().int().min(1),
    key: z
      .string()
      .refine(isListingMediaKey, { message: `Keys live under ${MEDIA_SITE}/listings/.` }),
    sha256: z.string().regex(sha256Pattern),
    source: z.string().refine(value => value.startsWith('https://') || value.startsWith('repo:'), {
      message: 'A source is an https URL or a repo: path.'
    }),
    width: z.number().int().min(1)
  })
  .strict()
  .superRefine((value, context) => {
    if (parseMediaKey(value.key)?.hash !== value.sha256.slice(0, MEDIA_HASH_LENGTH)) {
      context.addIssue({ code: 'custom', message: 'The key must name the object’s SHA-256.' })
    }
    if (contentTypeForKey(value.key) !== value.contentType) {
      context.addIssue({ code: 'custom', message: 'The key’s extension must match its type.' })
    }
  })

export const mediaPlanSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]+$/u),
    objects: z.array(planObject).min(1),
    site: z.literal(MEDIA_SITE),
    version: z.literal(1)
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>()
    value.objects.forEach((object, index) => {
      if (keys.has(object.key)) {
        context.addIssue({ code: 'custom', message: 'Duplicate key.', path: ['objects', index] })
      }
      keys.add(object.key)
    })
  })

export type MediaPlan = z.infer<typeof mediaPlanSchema>
export type MediaPlanObject = MediaPlan['objects'][number]

export type ObjectOutcome =
  | { key: string; status: 'present' | 'uploaded' | 'verified' }
  | { key: string; reason: string; status: 'failed' }

export interface UploadSummary {
  failed: Array<{ key: string; reason: string }>
  id: string
  present: number
  target: UploadTarget
  uploaded: number
  verified: number
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment value ${name}.`)
  return value
}

/** The plan file, refused unless it is a JSON file directly under d1/media. */
export function resolvePlanPath(planPath: string): string {
  const resolvedPath = resolve(planPath)
  const directory = resolve('d1/media')
  if (
    relative(directory, resolvedPath).includes('/') ||
    !resolvedPath.startsWith(`${directory}/`)
  ) {
    throw new Error('Media plans must be checked in directly under d1/media.')
  }
  if (!resolvedPath.endsWith('.json')) throw new Error('A media plan is a .json file.')
  return resolvedPath
}

export function validateUploadContext(env: NodeJS.ProcessEnv, target: UploadTarget): void {
  const { branch, confirmation, workflowRef } = uploadTargets[target]
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true') {
    throw new Error('A media upload requires GitHub Actions (use --dry-run locally).')
  }
  if (!env.GITHUB_WORKFLOW_REF?.includes(workflowRef)) {
    throw new Error(
      `A ${target} media upload requires ${workflowRef.split('/').at(-1)?.slice(0, -1)}.`
    )
  }
  if (env.GITHUB_REF !== `refs/heads/${branch}` || !env.GITHUB_SHA) {
    throw new Error(`A ${target} media upload requires reviewed ${branch}.`)
  }
  if (env.MEDIA_UPLOAD_CONFIRM !== confirmation) {
    throw new Error(`Explicit ${target} media upload confirmation ${confirmation} is required.`)
  }
}

async function sourceBytes(
  source: string,
  fetcher: typeof fetch | undefined
): Promise<Uint8Array | { reason: string }> {
  if (source.startsWith('repo:')) {
    const path = resolve(source.slice('repo:'.length))
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      return { reason: 'repo_file_missing' }
    }
    if (!real.startsWith(`${realpathSync(publicDirectory)}/`)) {
      return { reason: 'repo_file_outside_public' }
    }
    return new Uint8Array(readFileSync(real))
  }
  const result = await safeFetch(source, {
    accept: type => type !== 'text/html' && type !== 'application/xhtml+xml',
    acceptHeader: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
    // DNS-checked on every hop (#96 review S5); tests pass their own fetcher.
    fetcher: fetcher ?? nodeFetch,
    maxBytes: MAX_MEDIA_BYTES,
    webPortsOnly: true
  })
  return result.ok ? result.body : { reason: result.code }
}

/** Why fetched bytes are not the reviewed object, or null when they are. */
export function verifyObject(object: MediaPlanObject, body: Uint8Array): string | null {
  if (body.byteLength !== object.bytes) return `bytes ${body.byteLength} != ${object.bytes}`
  const digest = createHash('sha256').update(body).digest('hex')
  if (digest !== object.sha256) return 'sha256_mismatch'
  const sniffed = sniffImage(body)
  if (!sniffed.ok) return sniffed.reason
  if (IMAGE_CONTENT_TYPES[sniffed.format] !== object.contentType) return 'content_type_mismatch'
  if (sniffed.width !== object.width || sniffed.height !== object.height) {
    return 'dimensions_mismatch'
  }
  return null
}

export interface UploadOptions {
  concurrency?: number
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  target: UploadTarget
}

export async function uploadMediaPlan(
  planPath: string,
  options: UploadOptions
): Promise<UploadSummary> {
  const env = options.env ?? process.env
  const api = options.fetcher ?? fetch
  const resolvedPath = resolvePlanPath(planPath)
  const plan = mediaPlanSchema.parse(JSON.parse(readFileSync(resolvedPath, 'utf8')))
  const target = uploadTargets[options.target]
  if (!options.dryRun) validateUploadContext(env, options.target)
  // Production reads staging's bucket through the R2 API, so even a dry run needs credentials.
  if (!options.dryRun || options.target === 'production') {
    requireEnvironment(env, 'CLOUDFLARE_ACCOUNT_ID')
    requireEnvironment(env, 'CLOUDFLARE_API_TOKEN')
  }

  async function handle(object: MediaPlanObject): Promise<ObjectOutcome> {
    if (!options.dryRun) {
      // What the bucket already holds is verified, never trusted or overwritten (#97 B2).
      const existing = await getR2Object(target.bucket, object.key, env, api)
      if (existing) {
        const mismatch = verifyObject(object, existing)
        return mismatch
          ? { key: object.key, reason: `present_mismatch:${mismatch}`, status: 'failed' }
          : { key: object.key, status: 'present' }
      }
    }
    // Production copies staging's verified object; staging fetches the recorded source.
    const body =
      options.target === 'production'
        ? ((await getR2Object(uploadTargets.staging.bucket, object.key, env, api)) ?? {
            reason: 'not_in_staging_bucket'
          })
        : await sourceBytes(object.source, options.fetcher)
    if (!(body instanceof Uint8Array))
      return { key: object.key, reason: body.reason, status: 'failed' }
    const mismatch = verifyObject(object, body)
    if (mismatch) return { key: object.key, reason: mismatch, status: 'failed' }
    if (options.dryRun) return { key: object.key, status: 'verified' }
    const failure = await putR2Object(object, body, target.bucket, MEDIA_CACHE_CONTROL, env, api)
    return failure
      ? { key: object.key, reason: failure, status: 'failed' }
      : { key: object.key, status: 'uploaded' }
  }

  const outcomes: ObjectOutcome[] = []
  const queue = [...plan.objects]
  const workers = Array.from({ length: options.concurrency ?? 6 }, async () => {
    for (let object = queue.shift(); object; object = queue.shift()) {
      try {
        outcomes.push(await handle(object))
      } catch (error) {
        const reason = describeFetchError(error).slice(0, 200)
        outcomes.push({ key: object.key, reason, status: 'failed' })
      }
    }
  })
  await Promise.all(workers)
  return {
    failed: outcomes
      .flatMap(outcome =>
        outcome.status === 'failed' ? [{ key: outcome.key, reason: outcome.reason }] : []
      )
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    id: plan.id,
    present: outcomes.filter(outcome => outcome.status === 'present').length,
    target: options.target,
    uploaded: outcomes.filter(outcome => outcome.status === 'uploaded').length,
    verified: outcomes.filter(outcome => outcome.status === 'verified').length
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(value => value !== '--')
  const dryRun = args.includes('--dry-run')
  const targetArg = args.find(value => value.startsWith('--target='))?.slice('--target='.length)
  const planPath = args.find(value => !value.startsWith('--'))
  if ((targetArg !== 'staging' && targetArg !== 'production') || !planPath) {
    throw new Error(
      'Usage: pnpm tsx scripts/media-upload.ts --target=<staging|production> [--dry-run] d1/media/<plan>.json'
    )
  }
  const summary = await uploadMediaPlan(planPath, { dryRun, target: targetArg })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed.length > 0) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
