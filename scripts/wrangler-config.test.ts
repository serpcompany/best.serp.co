import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { project } from './project'

type Service = { binding?: string; service?: string }
type WorkerConfig = {
  compatibility_flags?: string[]
  keep_names?: boolean
  name?: string
  observability?: { enabled?: boolean; redact_query_string?: boolean }
  services?: Service[]
  upload_source_maps?: boolean
}
type WranglerConfig = WorkerConfig & { env: Record<'production' | 'staging', WorkerConfig> }

const config = JSON.parse(
  readFileSync(resolve(project.wranglerConfigPath), 'utf8')
) as WranglerConfig
// Every environment is checked: inheritable keys can still be overridden per environment, and
// named environments inherit no bindings, services, or observability from the top level.
const environments: Array<[string, WorkerConfig]> = [
  ['local (top level)', config],
  ['staging', config.env.staging],
  ['production', config.env.production]
]
const deployed = environments.slice(1)

describe('Worker configuration (serp web-stack/nextjs-on-workers.md)', () => {
  // esbuild's keep_names wraps bundled functions in __name(). next-themes serializes its theme
  // function with toString() into an inline <script>, so the browser received __name(...) and
  // threw "__name is not defined" on every page before the theme applied (#198).
  it.each(environments)('turns off keep_names in %s', (_name, environment) => {
    expect(environment.keep_names).toBe(false)
  })

  it.each(environments)('sets the standard compatibility flags in %s', (_name, environment) => {
    expect(environment.compatibility_flags ?? config.compatibility_flags).toEqual(
      expect.arrayContaining(['nodejs_compat', 'global_fetch_strictly_public'])
    )
  })

  it.each(environments)('uploads source maps in %s', (_name, environment) => {
    expect(environment.upload_source_maps).toBe(true)
  })

  it.each(environments)(
    'binds WORKER_SELF_REFERENCE to its own Worker in %s',
    (_name, environment) => {
      expect(environment.services).toContainEqual({
        binding: 'WORKER_SELF_REFERENCE',
        service: environment.name
      })
    }
  )

  // Providers send buyers back with tokens in the query string (serp web-stack/payments.md).
  it.each(deployed)('keeps Workers Logs on, without query strings, in %s', (_name, environment) => {
    expect(environment.observability).toMatchObject({ enabled: true, redact_query_string: true })
  })
})
