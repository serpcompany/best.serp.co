import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { project } from './project'

export const canonicalLocalMigrationsDirectory = resolve('d1/drizzle')

interface WranglerConfig {
  assets?: { binding?: string; directory?: string }
  d1_databases?: Array<{
    binding?: string
    database_id?: string
    database_name?: string
    migrations_dir?: string
    migrations_table?: string
  }>
  main?: string
  name?: string
  vars?: Record<string, string | undefined>
}

/** Variables from the retired multi-site runtime that must not return. */
const retiredSiteVariables = ['NEXT_PUBLIC_SITE_ID', 'SITE_ID'] as const

/**
 * Validates that the top level of the Wrangler config is the dedicated local
 * best.serp.co Worker: local identity, local D1 binding, `d1/drizzle` history recorded in the
 * declared `d1_migrations` ledger, the `apps/web` Worker entry (which wraps the OpenNext
 * build), and its assets.
 */
export function validateCanonicalLocalConfig(
  configPath: string = project.wranglerConfigPath
): WranglerConfig {
  const absoluteConfigPath = resolve(configPath)
  const config = JSON.parse(readFileSync(absoluteConfigPath, 'utf8')) as WranglerConfig
  const binding = config.d1_databases?.find(candidate => candidate.binding === 'DB')
  if (config.name !== project.local.workerName || config.vars?.D1_RUNTIME_ENV !== 'local') {
    throw new Error(
      `${configPath} is not the dedicated local ${project.domain} Worker (expected name ${project.local.workerName} and D1_RUNTIME_ENV=local).`
    )
  }
  const retired = retiredSiteVariables.filter(name => config.vars?.[name] !== undefined)
  if (retired.length > 0) {
    throw new Error(
      `${configPath} still declares retired multi-site variables: ${retired.join(', ')}. Remove them; the repository builds only ${project.domain}.`
    )
  }
  const expectedAppRoot = resolve(project.appDirectory, '.open-next')
  if (
    !config.main ||
    resolve(dirname(absoluteConfigPath), config.main) !== resolve(project.workerEntryPath) ||
    config.assets?.binding !== 'ASSETS' ||
    !config.assets.directory ||
    resolve(dirname(absoluteConfigPath), config.assets.directory) !==
      resolve(expectedAppRoot, 'assets')
  ) {
    throw new Error(
      `${configPath} is not wired to the ${project.appDirectory} OpenNext Worker and assets.`
    )
  }
  if (
    !binding ||
    binding.database_name !== project.local.databaseName ||
    binding.database_id !== project.local.databaseId
  ) {
    throw new Error('Refusing non-local, staging, or production D1 identity.')
  }
  if (
    !binding.migrations_dir ||
    resolve(dirname(absoluteConfigPath), binding.migrations_dir) !==
      canonicalLocalMigrationsDirectory
  ) {
    throw new Error('Canonical local D1 must apply the d1/drizzle migration history.')
  }
  if (binding.migrations_table !== project.migrationsTable) {
    throw new Error(
      `Canonical local D1 must declare migrations_table "${project.migrationsTable}", the ledger staging and production use.`
    )
  }
  return config
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    validateCanonicalLocalConfig()
    console.log(
      `${project.wranglerConfigPath} is the isolated local ${project.domain} Worker and D1 configuration.`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
