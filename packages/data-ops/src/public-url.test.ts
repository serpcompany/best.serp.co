import { describe, expect, it } from 'vitest'
import { URL_VALIDATION_ERRORS, validatePublicHttpUrl } from './public-url'

describe('shared public HTTP URL policy', () => {
  it('accepts public HTTP(S) URLs and returns the parsed URL', () => {
    expect(validatePublicHttpUrl('https://example.com/path')).toMatchObject({
      ok: true,
      url: new URL('https://example.com/path')
    })
    expect(validatePublicHttpUrl('http://8.8.8.8/').ok).toBe(true)
  })

  it('preserves format and protocol diagnostics', () => {
    expect(validatePublicHttpUrl('not a url')).toEqual({
      error: URL_VALIDATION_ERRORS.FORMAT,
      ok: false
    })
    expect(validatePublicHttpUrl('file:///tmp/private')).toEqual({
      error: URL_VALIDATION_ERRORS.PROTOCOL,
      ok: false
    })
  })

  it.each([
    'http://localhost/',
    'http://service.local/',
    'http://metadata.google.internal/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://100.64.0.1/',
    'http://127.0.0.1/',
    'http://169.254.1.1/',
    'http://172.16.0.1/',
    'http://192.168.0.1/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:7f00:1]/'
  ])('rejects local or restricted target %s', value => {
    expect(validatePublicHttpUrl(value)).toEqual({
      error: URL_VALIDATION_ERRORS.RESTRICTED_HOST,
      ok: false
    })
  })
})
