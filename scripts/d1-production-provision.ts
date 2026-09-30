import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  provisionReplacementDatabase,
  type ReplacementProvisionDependencies
} from './d1-database-provision'
import { parseSiteId, resolveSiteTarget, type SiteId } from './site-targets'

const workflowName = 'provision-d1-replacement-production'

export async function provisionReplacementProduction(
  siteId: SiteId,
  env: NodeJS.ProcessEnv,
  dependencies?: ReplacementProvisionDependencies,
  recordCreatedIdentity?: (receipt: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
  const target = resolveSiteTarget(siteId)
  return provisionReplacementDatabase(
    {
      confirmation: env.D1_PRODUCTION_PROVISION_CONFIRM,
      environment: 'production',
      expectedConfirmation: target.replatform.productionProvisioningConfirmation,
      expectedReplacementName: target.replatform.productionDatabaseName,
      protectedEnvironment: target.protectedEnvironment.production,
      replacementDatabaseId: env.CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_ID,
      replacementDatabaseName: env.CLOUDFLARE_D1_REPLACEMENT_PRODUCTION_DATABASE_NAME,
      siteId,
      sourceDatabaseId: env.CLOUDFLARE_D1_PRODUCTION_DATABASE_ID,
      sourceDatabaseName: env.CLOUDFLARE_D1_PRODUCTION_DATABASE_NAME,
      sourcePlacement: env.CLOUDFLARE_D1_PRODUCTION_PLACEMENT,
      sourcePlacementEnvironmentName: target.protectedEnvironment.production,
      sourcePlacementVariableName: 'CLOUDFLARE_D1_PRODUCTION_PLACEMENT',
      workerName: env.CLOUDFLARE_WORKER_PRODUCTION_NAME,
      workflowName,
      workflowRefSuffix: `/.github/workflows/${workflowName}.yml@refs/heads/main`
    },
    env,
    dependencies,
    recordCreatedIdentity
  )
}

function parseCli(argv: string[]): { output: string; siteId: SiteId } {
  if (argv.length !== 4 || argv[0] !== '--site' || argv[2] !== '--output') {
    throw new Error(
      'Usage: d1-production-provision.ts --site <site-id> --output <path>. Remediation: Review docs/D1_CUTOVER.md before retrying.'
    )
  }
  if (!argv[3]?.trim()) throw new Error('--output must be nonempty.')
  return { output: resolve(argv[3]), siteId: parseSiteId(argv[1]) }
}

async function main() {
  const { output, siteId } = parseCli(process.argv.slice(2))
  const writeReceipt = (receipt: Record<string, unknown>) =>
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  const evidence = await provisionReplacementProduction(
    siteId,
    process.env,
    undefined,
    writeReceipt
  )
  writeReceipt(evidence)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
