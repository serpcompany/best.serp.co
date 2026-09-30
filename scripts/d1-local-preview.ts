import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCanonicalLocalConfig } from './d1-local-config'
import { configuredFreshD1StateRoot } from './d1-local-state'
import { project } from './project'

export function canonicalPreviewCommand(): {
  args: string[]
  statePath: string
} {
  validateCanonicalLocalConfig()
  const statePath = configuredFreshD1StateRoot()
  return {
    args: [
      '--filter',
      project.appPackageName,
      'exec',
      'opennextjs-cloudflare',
      'preview',
      '--config',
      resolve(project.wranglerConfigPath),
      '--persist-to',
      statePath,
      '--port',
      process.env.PORT || '8787'
    ],
    statePath
  }
}

export function runCanonicalPreview(): void {
  const command = canonicalPreviewCommand()
  const result = spawnSync('pnpm', command.args, { env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status) process.exitCode = result.status
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const extra = process.argv.slice(2).filter(value => value !== '--')
    if (extra.length > 0) {
      throw new Error(
        `Local preview takes no arguments (received ${extra.join(' ')}); it always serves ${project.domain} from the canonical local D1 state.`
      )
    }
    runCanonicalPreview()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
