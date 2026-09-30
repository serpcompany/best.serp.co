import { existsSync } from 'node:fs'
import path from 'node:path'

export function resolveWorkspacePath(relativePath: string, cwd = process.cwd()): string {
  const directPath = path.resolve(cwd, relativePath)

  if (existsSync(directPath)) {
    return directPath
  }

  let current = cwd

  for (let depth = 0; depth < 6; depth += 1) {
    current = path.resolve(current, '..')
    const candidate = path.resolve(current, relativePath)

    if (existsSync(candidate)) {
      return candidate
    }
  }

  return directPath
}
