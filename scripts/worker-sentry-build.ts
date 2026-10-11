/**
 * Records the build's Sentry values for the Worker entry (#210): `pnpm worker:build` runs this
 * after `opennextjs-cloudflare build`, with the same environment.
 *
 * Next.js inlines `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_RELEASE` into its own bundle
 * at build time. Wrangler bundles the Worker entry (`apps/web/worker.ts`) later, at deploy or
 * preview, in a step that no longer has them, so they are written next to OpenNext's output, and
 * `apps/web/worker-build-output.js` imports them like the routes manifest. Unset values stay
 * unset, and the Worker entry reports nothing without a DSN (`worker-errors.ts`).
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { project } from './project'

/** The JSON the Worker entry imports, beside OpenNext's `worker.js`. */
export const WORKER_SENTRY_BUILD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  project.appDirectory,
  '.open-next',
  'worker-sentry.json'
)

/** The DSN and the commit, as the Next.js build received them (`SentryBuild` in sentry.ts). */
export function workerSentryBuild(env: Partial<NodeJS.ProcessEnv>): {
  commit?: string
  dsn?: string
} {
  return {
    commit: env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    dsn: env.NEXT_PUBLIC_SENTRY_DSN || undefined
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const build = workerSentryBuild(process.env)
  writeFileSync(WORKER_SENTRY_BUILD_PATH, `${JSON.stringify(build)}\n`)
  console.log(
    `Worker entry Sentry: ${build.dsn ? 'DSN set' : 'no DSN, off'}, commit ${build.commit ?? 'unset'}`
  )
}
