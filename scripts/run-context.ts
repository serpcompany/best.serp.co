import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const workspaceRoot = resolve(process.cwd())

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function createRunTempDir(scope: string, siteId: string): {
  cleanup: () => void
  path: string
} {
  const prefix = resolve(
    workspaceRoot,
    'tmp',
    sanitizePathSegment(scope),
    `${sanitizePathSegment(siteId)}-`
  )

  mkdirSync(resolve(prefix, '..'), { recursive: true })

  const path = mkdtempSync(prefix)

  return {
    cleanup: () => {
      rmSync(path, { force: true, recursive: true })
    },
    path
  }
}
