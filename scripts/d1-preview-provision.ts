import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseCloudflareHttpFailure,
  provisionReplacementDatabase,
  type ReplacementProvisionDependencies
} from './d1-database-provision'
import { resolveSiteTarget, type SiteId } from './site-targets'

export { parseCloudflareHttpFailure }

const provisioningSiteId = 'pornvideodownloaders.com' as const
const workflowName = 'provision-pornvideodownloaders-replacement-preview'

export async function provisionPvdReplacementPreview(
  siteId: SiteId,
  env: NodeJS.ProcessEnv,
  dependencies?: ReplacementProvisionDependencies
): Promise<Record<string, unknown>> {
  if (siteId !== provisioningSiteId) {
    throw new Error(
      'This workflow provisions only PVD Preview. Remediation: Review docs/D1_CUTOVER.md before retrying.'
    )
  }
  const target = resolveSiteTarget(siteId)
  return provisionReplacementDatabase(
    {
      confirmation: env.D1_PREVIEW_PROVISION_CONFIRM,
      environment: 'preview',
      expectedConfirmation: target.replatform.previewProvisioningConfirmation ?? '',
      expectedReplacementName: target.replatform.previewDatabaseName,
      protectedEnvironment: target.protectedEnvironment.preview,
      replacementDatabaseId: env.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_ID,
      replacementDatabaseName: env.CLOUDFLARE_D1_REPLACEMENT_PREVIEW_DATABASE_NAME,
      siteId,
      sourceDatabaseId: env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID,
      sourceDatabaseName: env.CLOUDFLARE_D1_PREVIEW_DATABASE_NAME,
      sourcePlacement: env.CLOUDFLARE_D1_PREVIEW_PLACEMENT,
      sourcePlacementEnvironmentName: target.protectedEnvironment.preview,
      sourcePlacementVariableName: 'CLOUDFLARE_D1_PREVIEW_PLACEMENT',
      workerName: env.CLOUDFLARE_WORKER_PREVIEW_NAME,
      workflowName,
      workflowRefSuffix: `/.github/workflows/${workflowName}.yml@refs/heads/main`
    },
    env,
    dependencies
  )
}

function parseCli(argv: string[]): { output: string; siteId: SiteId } {
  if (argv.length !== 4 || argv[0] !== '--site' || argv[2] !== '--output') {
    throw new Error(
      'Usage: d1-preview-provision.ts --site pornvideodownloaders.com --output <path>. Remediation: Review docs/D1_CUTOVER.md before retrying.'
    )
  }
  if (!argv[3]?.trim()) throw new Error('--output must be nonempty.')
  return { output: resolve(argv[3]), siteId: argv[1] as SiteId }
}

async function main() {
  const { output, siteId } = parseCli(process.argv.slice(2))
  const evidence = await provisionPvdReplacementPreview(siteId, process.env)
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
