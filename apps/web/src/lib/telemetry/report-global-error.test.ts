import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportGlobalError } from './report-global-error'

afterEach(() => {
  vi.useRealTimers()
})

describe('reporting the global error page (#355)', () => {
  it('captures the error through the SDK the browser entry started', async () => {
    const captureException = vi.fn()
    const error = new Error('root layout failed')
    await reportGlobalError(error, '/', async () => ({ captureException }))
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('rethrows the error for the global handler when the SDK chunk fails to load', async () => {
    vi.useFakeTimers()
    const error = new Error('root layout failed')
    await reportGlobalError(error, '/', () =>
      Promise.reject(new Error('Loading chunk 1639 failed'))
    )
    expect(() => vi.runAllTimers()).toThrow(error)
  })
})

describe('one server failure, one event (#401)', () => {
  /** What Next.js hands an error page for a server error: a redacted message and a digest. */
  const serverError = () => Object.assign(new Error('root layout failed'), { digest: '2667249125' })

  it('leaves a server error on a reporting path to the server’s report', async () => {
    const loadSdk = vi.fn(async () => ({ captureException: vi.fn() }))
    await reportGlobalError(serverError(), '/admin/listings/', loadSdk)
    expect(loadSdk).not.toHaveBeenCalled()
  })

  it('still reports a public page’s server error, which the server only logs', async () => {
    const captureException = vi.fn()
    const error = serverError()
    await reportGlobalError(error, '/products/fixture/', async () => ({ captureException }))
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error)
  })
})
