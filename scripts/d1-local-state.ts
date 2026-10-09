import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Directory name of the isolated local D1 state below each state root. */
export const localD1StateDirectoryName = 'best-serp-co'

export interface D1StateManifest {
  d1StateDirectory?: string
  repositoryPath?: string
}

interface FreshD1StateRootInput {
  harnessStateDirectory?: string
  manifest?: D1StateManifest
  repositoryRoot: string
}

export function resolveFreshD1StateRoot(input: FreshD1StateRootInput): string {
  const repositoryRoot = resolve(input.repositoryRoot)
  if (input.harnessStateDirectory) {
    return resolve(input.harnessStateDirectory, 'drizzle', localD1StateDirectoryName)
  }
  if (input.manifest) {
    if (resolve(input.manifest.repositoryPath || '') !== repositoryRoot) {
      throw new Error('Runtime manifest belongs to another worktree.')
    }
    if (!input.manifest.d1StateDirectory) {
      throw new Error('Runtime manifest has no D1 state directory.')
    }
    return resolve(input.manifest.d1StateDirectory, 'drizzle', localD1StateDirectoryName)
  }
  return resolve(repositoryRoot, '.wrangler/drizzle-state', localD1StateDirectoryName)
}

export function configuredFreshD1StateRoot(): string {
  const repositoryRoot = resolve('.')
  const manifestPath = resolve(repositoryRoot, '.runtime/manifest.json')
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as D1StateManifest)
    : undefined
  return resolveFreshD1StateRoot({
    harnessStateDirectory: process.env.HARNESS_D1_STATE_DIRECTORY,
    manifest,
    repositoryRoot
  })
}

/**
 * Whether the local D1 below `stateRoot` exists yet: Wrangler creates its SQLite file on the first
 * migration. A fresh worktree has none until `pnpm db:seed:local` runs.
 */
export function hasLocalD1Database(stateRoot: string): boolean {
  const directory = resolve(stateRoot, 'v3', 'd1', 'miniflare-D1DatabaseObject')
  return (
    existsSync(directory) &&
    readdirSync(directory).some(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  )
}
