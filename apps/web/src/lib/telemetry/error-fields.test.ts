import { describe, expect, it } from 'vitest'
import { BillingProviderError } from '../billing/provider'
import { CodedError, FAILURE_CODES } from './coded-error'
import { errorCode, errorFields, stackFrames } from './error-fields'
import { ERROR_CODES } from './sentry'

const PRIVATE = 'typed@example.com'

/** A Drizzle failure: the statement and its bound values in the message, D1's error as cause. */
function drizzleError(params: string, cause: string): Error {
  return new Error(`Failed query: insert into claims (domain) values (?)\nparams: ${params}`, {
    cause: new Error(cause)
  })
}

describe('what a Worker log line says about an error (#211)', () => {
  it('is a stable code and the name, never the message', () => {
    const fields = errorFields(drizzleError(PRIVATE, 'D1_ERROR: UNIQUE constraint failed'))
    expect(fields).toEqual({ code: 'D1_ERROR:constraint_failed', name: 'Error' })
    expect(JSON.stringify(fields)).not.toContain(PRIVATE)
  })

  it('takes an allowlisted code from the message, then the error’s own code', () => {
    expect(errorCode(new Error('search_failed'))).toBe('search_failed')
    expect(
      errorFields(new BillingProviderError(`No such customer: ${PRIVATE}`, 'provider_error', 502))
    ).toEqual({ code: 'provider_error', name: 'BillingProviderError' })
    expect(errorCode(Object.assign(new Error('x'), { code: 'invalid_url' }))).toBe('invalid_url')
  })

  it('logs a coded configuration or billing failure by its code, never its message', () => {
    const fields = errorFields(
      new CodedError('refund_paid_order_missing', 'No paid order for submission sub_1.')
    )
    expect(fields).toEqual({ code: 'refund_paid_order_missing', name: 'Error' })
    expect(JSON.stringify(fields)).not.toContain('sub_1')
    for (const code of FAILURE_CODES) expect(errorCode(new CodedError(code, 'x'))).toBe(code)
  })

  it('keeps the failure codes stable: snake_case, unique, and apart from the Sentry codes', () => {
    for (const code of FAILURE_CODES) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u)
    expect(new Set(FAILURE_CODES).size).toBe(FAILURE_CODES.length)
    expect(FAILURE_CODES.filter(code => (ERROR_CODES as readonly string[]).includes(code))).toEqual(
      []
    )
  })

  it('never takes a code that could be text', () => {
    expect(errorCode(Object.assign(new Error(PRIVATE), { code: PRIVATE }))).toBe('UNKNOWN')
    expect(errorCode(Object.assign(new Error('x'), { code: 500 }))).toBe('UNKNOWN')
    expect(errorCode(new Error(`search_failed ${PRIVATE}`))).toBe('UNKNOWN')
  })

  it('logs anything else as UNKNOWN, with no name unless it is an error', () => {
    expect(errorFields(new TypeError(`Invalid URL: ${PRIVATE}`))).toEqual({
      code: 'UNKNOWN',
      name: 'TypeError'
    })
    expect(errorFields(PRIVATE)).toEqual({ code: 'UNKNOWN' })
    expect(errorFields(null)).toEqual({ code: 'UNKNOWN' })
  })

  it('keeps the stack frames and drops the header that repeats the message', () => {
    const error = drizzleError(`${PRIVATE}\n    at not-a-frame`, 'D1_ERROR')
    const frames = stackFrames(error)
    expect(frames).toMatch(/^\s+at /u)
    expect(frames).not.toContain(PRIVATE)
    expect(frames).not.toContain('not-a-frame')
    expect(frames?.split('\n').every(line => /^\s+at /u.test(line))).toBe(true)
    expect(stackFrames(Object.assign(new Error('x'), { stack: undefined }))).toBeUndefined()
  })
})
