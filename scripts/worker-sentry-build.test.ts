import { describe, expect, it } from 'vitest'
import { WORKER_SENTRY_BUILD_PATH, workerSentryBuild } from './worker-sentry-build'

describe('the build values the Worker entry reports with (#210)', () => {
  it('records the DSN and the commit the Next.js build received', () => {
    expect(
      workerSentryBuild({
        NEXT_PUBLIC_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/2',
        NEXT_PUBLIC_SENTRY_RELEASE: 'abc1234'
      })
    ).toEqual({ commit: 'abc1234', dsn: 'https://public@o1.ingest.sentry.io/2' })
  })

  it('leaves unset and empty values unset, so the Worker entry stays off', () => {
    expect(workerSentryBuild({})).toEqual({ commit: undefined, dsn: undefined })
    // E2E builds set an empty DSN (playwright.config.ts).
    expect(workerSentryBuild({ NEXT_PUBLIC_SENTRY_DSN: '' }).dsn).toBeUndefined()
  })

  it('writes beside OpenNext’s worker.js, where worker-build-output.js imports it', () => {
    expect(WORKER_SENTRY_BUILD_PATH).toMatch(/\/apps\/web\/\.open-next\/worker-sentry\.json$/u)
  })
})
