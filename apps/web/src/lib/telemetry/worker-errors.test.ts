import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SentryBuild } from './sentry'

/**
 * `worker-sentry.ts` holds the SDK. Mocked, so each test sees whether the module was evaluated at
 * all (`vi.resetModules` before each test re-arms it): a public page must never import it (#355).
 */
const sdk = vi.hoisted(() => ({
  evaluated: 0,
  reportWorkerErrors: vi.fn(async (..._args: unknown[]) => {})
}))
vi.mock('./worker-sentry', () => {
  sdk.evaluated++
  return { reportWorkerErrors: sdk.reportWorkerErrors }
})

const BUILD: SentryBuild = { commit: 'abc1234', dsn: 'https://public@o1.ingest.sentry.io/2' }

async function reporter(build: SentryBuild = BUILD) {
  const { workerErrors } = await import('./worker-errors')
  return workerErrors({ build })
}

/** A Worker execution context that keeps what `waitUntil` was given. */
function executionContext() {
  const pending: Promise<unknown>[] = []
  return {
    context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    pending,
    settled: () => Promise.all(pending)
  }
}

const failing = (error: unknown) => async (): Promise<Response> => {
  throw error
}

beforeEach(() => {
  vi.resetModules()
  sdk.evaluated = 0
  sdk.reportWorkerErrors.mockClear()
})

afterEach(() => vi.restoreAllMocks())

describe('a request error that escapes the Worker entry (#210)', () => {
  it('reports from a signed-in or operational path, and still throws', async () => {
    const errors = await reporter()
    const { context, pending, settled } = executionContext()
    const error = new Error('admin gate failed')
    const request = new Request('https://best.serp.co/admin/listings/?q=private', {
      method: 'POST'
    })

    await expect(
      errors.fetch(request, { SITE_ENVIRONMENT: 'staging' }, context, failing(error))
    ).rejects.toBe(error)
    expect(pending).toHaveLength(1)
    await settled()

    expect(sdk.evaluated).toBe(1)
    expect(sdk.reportWorkerErrors).toHaveBeenCalledTimes(1)
    expect(sdk.reportWorkerErrors).toHaveBeenCalledWith(
      [
        {
          error,
          mechanism: 'cloudflare.fetch',
          request: { method: 'POST', url: 'https://best.serp.co/admin/listings/?q=private' },
          transaction: 'POST /admin/listings/'
        }
      ],
      { build: BUILD, environment: 'staging' }
    )
  })

  it('covers every surface the Next.js server SDK reports from', async () => {
    for (const path of [
      '/account/',
      '/api/admin/listings/1/',
      '/claims/x/',
      '/login/',
      '/submit/'
    ]) {
      const errors = await reporter()
      const { context, settled } = executionContext()
      await expect(
        errors.fetch(new Request(`https://best.serp.co${path}`), {}, context, failing(new Error()))
      ).rejects.toThrow()
      await settled()
    }
    expect(sdk.reportWorkerErrors).toHaveBeenCalledTimes(5)
  })

  it('never imports the SDK for a public page or the search API (#401): the runtime logs its exception', async () => {
    const errors = await reporter()
    const { context, pending } = executionContext()
    for (const path of [
      '/',
      '/products/fixture-studio/',
      '/search/?q=admin',
      '/api/search?q=admin',
      '/api/search/?q=admin',
      '/sitemap-products.xml',
      '/products/admin/',
      '/no-such-page/'
    ]) {
      const error = new Error(`edge cache failed on ${path}`)
      await expect(
        errors.fetch(new Request(`https://best.serp.co${path}`), {}, context, failing(error))
      ).rejects.toBe(error)
    }
    expect(pending).toHaveLength(0)
    expect(sdk.evaluated).toBe(0)
  })

  it('never imports the SDK without a DSN, or for a response', async () => {
    const off = await reporter({ commit: 'abc1234' })
    const { context, pending } = executionContext()
    await expect(
      off.fetch(new Request('https://best.serp.co/admin/'), {}, context, failing(new Error()))
    ).rejects.toThrow()

    const on = await reporter()
    const response = new Response('ok')
    await expect(
      on.fetch(new Request('https://best.serp.co/admin/'), {}, context, async () => response)
    ).resolves.toBe(response)

    expect(pending).toHaveLength(0)
    expect(sdk.evaluated).toBe(0)
  })

  it('logs a failure to report, with a code and never a message, and still throws the error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    sdk.reportWorkerErrors.mockRejectedValueOnce(new Error('typed@example.com unreachable'))
    const errors = await reporter()
    const { context, settled } = executionContext()
    const error = new Error('gate failed')

    await expect(
      errors.fetch(
        new Request('https://best.serp.co/api/billing/webhook/'),
        {},
        context,
        failing(error)
      )
    ).rejects.toBe(error)
    await expect(settled()).resolves.toBeDefined()

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({
      code: 'UNKNOWN',
      event: 'worker_sentry_failed',
      name: 'Error'
    })
  })
})

describe('failed cron jobs (#210)', () => {
  it('reports each failed job once, and waits for the reports', async () => {
    const errors = await reporter()
    const first = new Error('draft read failed')
    const second = new Error('badge check failed')

    await errors.scheduled(
      [
        { error: first, job: 'draft-reminders-and-expiry' },
        { error: second, job: 'badge-program' }
      ],
      '0 * * * *',
      { SITE_ENVIRONMENT: 'production' }
    )

    expect(sdk.reportWorkerErrors).toHaveBeenCalledTimes(1)
    expect(sdk.reportWorkerErrors).toHaveBeenCalledWith(
      [
        {
          error: first,
          mechanism: 'cloudflare.scheduled',
          transaction: 'draft-reminders-and-expiry (cron 0 * * * *)'
        },
        {
          error: second,
          mechanism: 'cloudflare.scheduled',
          transaction: 'badge-program (cron 0 * * * *)'
        }
      ],
      { build: BUILD, environment: 'production' }
    )
  })

  it('never imports the SDK when every job succeeds, or without a DSN', async () => {
    await (await reporter()).scheduled([], '0 * * * *', {})
    await (await reporter({})).scheduled(
      [{ error: new Error(), job: 'listing-media' }],
      '*/15 * * * *',
      {}
    )
    expect(sdk.evaluated).toBe(0)
  })

  it('never rejects when reporting fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sdk.reportWorkerErrors.mockRejectedValueOnce(new Error('offline'))
    const errors = await reporter()
    await expect(
      errors.scheduled([{ error: new Error(), job: 'listing-media' }], '*/15 * * * *', {})
    ).resolves.toBeUndefined()
  })
})
