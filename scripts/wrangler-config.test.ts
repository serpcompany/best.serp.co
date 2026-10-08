import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { project } from './project'

type WorkerConfig = { keep_names?: boolean; name?: string }
type WranglerConfig = WorkerConfig & { env: Record<'production' | 'staging', WorkerConfig> }

const config = JSON.parse(readFileSync(resolve(project.wranglerConfigPath), 'utf8')) as WranglerConfig
// Named environments inherit nothing they don't repeat, so every check covers all three.
const environments: Array<[string, WorkerConfig]> = [
  ['local (top level)', config],
  ['staging', config.env.staging],
  ['production', config.env.production]
]

describe('Worker configuration', () => {
  // esbuild's keep_names wraps bundled functions in __name(). next-themes serializes its theme
  // function with toString() into an inline <script>, so the browser received __name(...) and
  // threw "__name is not defined" on every page before the theme applied (#198).
  it.each(environments)('turns off keep_names in %s', (_name, environment) => {
    expect(environment.keep_names).toBe(false)
  })
})
