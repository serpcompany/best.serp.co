import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportGlobalError } from './report-global-error'

afterEach(() => {
  vi.useRealTimers()
})

describe('reporting the global error page (#355)', () => {
  it('captures the error through the SDK the browser entry started', async () => {
    const captureException = vi.fn()
    const error = new Error('root layout failed')
    await reportGlobalError(error, async () => ({ captureException }))
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('rethrows the error for the global handler when the SDK chunk fails to load', async () => {
    vi.useFakeTimers()
    const error = new Error('root layout failed')
    await reportGlobalError(error, () => Promise.reject(new Error('Loading chunk 1639 failed')))
    expect(() => vi.runAllTimers()).toThrow(error)
  })
})
