import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSiteTarget, type SiteId } from './site-targets'

const cloudflareApi = 'https://api.cloudflare.com/client/v4'
const routinePreviewWorkflowBySite: Record<SiteId, string> = {
  'pornvideodownloaders.com': 'deploy-pornvideodownloaders.yml',
  'serp.software': 'build-and-deploy.yml'
}

export interface RoutinePreviewIdentityDependencies {
  fetchAccount(accountId: string, token: string): Promise<unknown>
  fetchDatabase(accountId: string, databaseId: string, token: string): Promise<unknown>
  fetchWorker(accountId: string, workerName: string, token: string): Promise<unknown>
}

function fail(message: string): never {
  throw new Error(
    `${message} Remediation: reconcile the protected Preview values with scripts/site-targets.ts and docs/D1_CUTOVER.md before retrying.`
  )
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty.`)
  return value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function envelopeResult(value: unknown, label: string): Record<string, unknown> {
  const envelope = object(value, label)
  if (envelope.success !== true) fail(`${label} was not successful.`)
  return object(envelope.result, `${label}.result`)
}

async function cloudflareRequest(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${cloudflareApi}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    fail(`Cloudflare identity request returned non-JSON HTTP ${response.status}.`)
  }
  if (!response.ok) fail(`Cloudflare identity request failed with HTTP ${response.status}.`)
  return body
}

export const defaultRoutinePreviewIdentityDependencies: RoutinePreviewIdentityDependencies = {
  fetchAccount: (accountId, token) =>
    cloudflareRequest(`/accounts/${encodeURIComponent(accountId)}`, token),
  fetchDatabase: (accountId, databaseId, token) =>
    cloudflareRequest(
      `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`,
      token
    ),
  fetchWorker: (accountId, workerName, token) =>
    cloudflareRequest(
      `/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(workerName)}`,
      token
    )
}

function assertProtectedRoutinePreview(siteId: SiteId, env: NodeJS.ProcessEnv): void {
  const target = resolveSiteTarget(siteId)
  const workflow = routinePreviewWorkflowBySite[siteId]
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !env.GITHUB_WORKFLOW_REF?.endsWith(`/.github/workflows/${workflow}@refs/heads/main`) ||
    env.WORKER_PRODUCTION_CONFIRM !== target.confirmation.deploy.preview ||
    env.D1_RELEASE_GENERATION !== 'replatform'
  )
    fail('Routine Preview identity verification requires the exact protected main workflow.')
}

export async function verifyRoutinePreviewIdentity(
  siteId: SiteId,
  env: NodeJS.ProcessEnv,
  dependencies: RoutinePreviewIdentityDependencies = defaultRoutinePreviewIdentityDependencies
): Promise<Record<string, string>> {
  const target = resolveSiteTarget(siteId)
  const expected = target.activePreview
  assertProtectedRoutinePreview(siteId, env)

  const selected = {
    accountId: nonempty(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID'),
    databaseId: nonempty(
      env.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID,
      'CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID'
    ),
    databaseName: nonempty(
      env.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME,
      'CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME'
    ),
    workerName: nonempty(env.CLOUDFLARE_WORKER_PREVIEW_NAME, 'CLOUDFLARE_WORKER_PREVIEW_NAME')
  }
  const token = nonempty(env.CLOUDFLARE_API_TOKEN, 'CLOUDFLARE_API_TOKEN')
  if (
    selected.accountId !== expected.accountId ||
    selected.databaseId !== expected.databaseId ||
    selected.databaseName !== expected.databaseName ||
    selected.workerName !== expected.workerName
  )
    fail('Protected Preview values do not select the checked-in active identity.')

  const account = envelopeResult(
    await dependencies.fetchAccount(selected.accountId, token),
    'Cloudflare account identity'
  )
  if (account.id !== expected.accountId)
    fail('Observed Cloudflare account does not match the checked-in active Preview account.')

  const database = envelopeResult(
    await dependencies.fetchDatabase(selected.accountId, selected.databaseId, token),
    'Cloudflare D1 identity'
  )
  if (database.uuid !== expected.databaseId || database.name !== expected.databaseName)
    fail('Observed Cloudflare D1 does not match the checked-in active Preview database.')

  const worker = envelopeResult(
    await dependencies.fetchWorker(selected.accountId, selected.workerName, token),
    'Cloudflare Worker identity'
  )
  if ((worker.name ?? worker.id) !== expected.workerName)
    fail('Observed Cloudflare Worker does not match the checked-in active Preview Worker.')

  return {
    accountId: expected.accountId,
    databaseId: expected.databaseId,
    databaseName: expected.databaseName,
    environment: 'preview',
    siteId,
    workerName: expected.workerName
  }
}

async function main(): Promise<void> {
  const [command, siteFlag, siteValue] = process.argv.slice(2)
  if (command !== 'verify' || siteFlag !== '--site' || !siteValue)
    fail('Usage: d1-routine-preview-identity.ts verify --site <site-id>.')
  const target = resolveSiteTarget(siteValue)
  console.log(JSON.stringify(await verifyRoutinePreviewIdentity(target.siteId, process.env)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
