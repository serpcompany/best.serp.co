import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { resolveSiteTarget } from './site-targets'

export function canonicalPreviewCommand(siteId: string | undefined): {
  args: string[]
  statePath: string
} {
  const target = resolveSiteTarget(siteId)
  validateCanonicalLocalConfig(target)
  const statePath = configuredFreshD1StateRoot(target.siteId)
  return {
    args: [
      '--filter',
      target.appPackageName,
      'exec',
      'opennextjs-cloudflare',
      'preview',
      '--config',
      resolve(target.local.configPath),
      '--persist-to',
      statePath,
      '--port',
      process.env.PORT || '8787'
    ],
    statePath
  }
}

export function runCanonicalPreview(siteId: string | undefined): void {
  const command = canonicalPreviewCommand(siteId)
  const result = spawnSync('pnpm', command.args, { env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status) process.exitCode = result.status
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [siteFlag, siteId] = process.argv.slice(2)
  if (siteFlag !== '--site') {
    throw new Error('Local preview requires an explicit --site argument.')
  }
  runCanonicalPreview(siteId)
}
