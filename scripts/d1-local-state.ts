import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SiteId } from './site-targets'

export interface D1StateManifest {
  d1StateDirectory?: string
  repositoryPath?: string
}

interface FreshD1StateRootInput {
  harnessStateDirectory?: string
  manifest?: D1StateManifest
  repositoryRoot: string
  siteId: SiteId
}

export function resolveFreshD1StateRoot(input: FreshD1StateRootInput): string {
  const repositoryRoot = resolve(input.repositoryRoot)
  const siteDirectory = input.siteId.replaceAll('.', '-')
  if (input.harnessStateDirectory) {
    return resolve(input.harnessStateDirectory, 'drizzle', siteDirectory)
  }
  if (input.manifest) {
    if (resolve(input.manifest.repositoryPath || '') !== repositoryRoot) {
      throw new Error('Runtime manifest belongs to another worktree.')
    }
    if (!input.manifest.d1StateDirectory) {
      throw new Error('Runtime manifest has no D1 state directory.')
    }
    return resolve(input.manifest.d1StateDirectory, 'drizzle', siteDirectory)
  }
  return resolve(repositoryRoot, '.wrangler/drizzle-state', siteDirectory)
}

export function configuredFreshD1StateRoot(siteId: SiteId): string {
  const repositoryRoot = resolve('.')
  const manifestPath = resolve(repositoryRoot, '.runtime/manifest.json')
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as D1StateManifest)
    : undefined
  return resolveFreshD1StateRoot({
    harnessStateDirectory: process.env.HARNESS_D1_STATE_DIRECTORY,
    manifest,
    repositoryRoot,
    siteId
  })
}
