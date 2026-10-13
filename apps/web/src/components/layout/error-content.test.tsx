import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reportPageError } from './error-content'

const logger = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/lib/logging', () => ({ logger }))

beforeEach(() => {
  logger.error.mockClear()
})

/** What Next.js hands an error page for a server error: a redacted message and a digest. */
function serverError() {
  return Object.assign(new Error('An error occurred in the Server Components render.'), {
    digest: '2667249125'
  })
}

describe('the error page’s report: one server failure, one event (#401)', () => {
  it('skips a server error on a path whose server errors go to Sentry', () => {
    for (const pathname of ['/admin/', '/account/listings/', '/submit/', '/claims/fixture/']) {
      reportPageError(serverError(), pathname)
    }
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports a public page’s server error, which the server only logs', () => {
    const error = serverError()
    reportPageError(error, '/products/fixture/')
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(error)
  })

  it('reports a browser error on any path, which the server never saw', () => {
    const error = new Error('render failed in the browser')
    reportPageError(error, '/admin/')
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(error)
  })
})
