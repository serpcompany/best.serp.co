import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { SiteTarget } from './site-targets'

export const canonicalLocalMigrationsDirectory = resolve('d1/drizzle')

interface WranglerConfig {
  assets?: { binding?: string; directory?: string }
  d1_databases?: Array<{
    binding?: string
    database_id?: string
    database_name?: string
    migrations_dir?: string
  }>
  main?: string
  name?: string
  vars?: {
    D1_RUNTIME_ENV?: string
    NEXT_PUBLIC_SITE_ID?: string
    SITE_ID?: string
  }
}

export function validateCanonicalLocalConfig(target: SiteTarget): void {
  const configPath = resolve(target.local.configPath)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as WranglerConfig
  const binding = config.d1_databases?.find(candidate => candidate.binding === 'DB')
  if (
    config.name !== target.local.workerName ||
    config.vars?.D1_RUNTIME_ENV !== 'local' ||
    config.vars.SITE_ID !== target.siteId ||
    config.vars.NEXT_PUBLIC_SITE_ID !== target.siteId
  ) {
    throw new Error(`Wrangler config is not the dedicated local ${target.siteId} Worker.`)
  }
  const expectedAppRoot = resolve('apps', target.appPackageName, '.open-next')
  if (
    !config.main ||
    resolve(dirname(configPath), config.main) !== resolve(expectedAppRoot, 'worker.js') ||
    config.assets?.binding !== 'ASSETS' ||
    !config.assets.directory ||
    resolve(dirname(configPath), config.assets.directory) !== resolve(expectedAppRoot, 'assets')
  ) {
    throw new Error(`Wrangler config is not wired to the local ${target.siteId} application.`)
  }
  if (
    !binding ||
    binding.database_name !== target.local.databaseName ||
    binding.database_id !== target.local.databaseId
  ) {
    throw new Error('Refusing non-local, preview, or production D1 identity.')
  }
  if (
    !binding.migrations_dir ||
    resolve(dirname(configPath), binding.migrations_dir) !== canonicalLocalMigrationsDirectory
  ) {
    throw new Error(
      'Canonical local D1 must use d1/drizzle; legacy d1/migrations is recovery-only.'
    )
  }
}
