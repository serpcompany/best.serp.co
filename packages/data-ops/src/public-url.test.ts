import { describe, expect, it } from 'vitest'
import { ipv6Groups, URL_VALIDATION_ERRORS, validatePublicHttpUrl } from './public-url'

describe('shared public HTTP URL policy', () => {
  it('accepts public HTTP(S) URLs and returns the parsed URL', () => {
    expect(validatePublicHttpUrl('https://example.com/path')).toMatchObject({
      ok: true,
      url: new URL('https://example.com/path')
    })
    expect(validatePublicHttpUrl('http://8.8.8.8/').ok).toBe(true)
    expect(validatePublicHttpUrl('https://[2606:4700:4700::1111]/').ok).toBe(true)
    expect(validatePublicHttpUrl('https://[::ffff:8.8.8.8]/').ok).toBe(true)
    expect(validatePublicHttpUrl('https://local.example.com/').ok).toBe(true)
    expect(validatePublicHttpUrl('https://internal-tools.io/').ok).toBe(true)
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

  // PR #84 review round 1, finding 5.
  it.each([
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'http://evil@127.0.0.1/'
  ])('rejects credentials in %s', value => {
    expect(validatePublicHttpUrl(value)).toEqual({
      error: URL_VALIDATION_ERRORS.CREDENTIALS,
      ok: false
    })
  })

  it.each([
    'http://localhost/',
    'http://localhost./',
    'http://LOCALHOST/',
    'http://foo.localhost./',
    'http://localhost.localdomain/',
    'http://ip6-localhost/',
    'http://service.local/',
    'http://printer.lan/',
    'http://router.home.arpa/',
    'http://db.internal/',
    'http://db.internal./',
    'http://metadata.google.internal/',
    'http://0.0.0.0/',
    'http://0/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://10.0.0.1/',
    'http://100.64.0.1/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://172.16.0.1/',
    'http://192.0.0.8/',
    'http://192.0.2.1/',
    'http://192.168.0.1/',
    'http://198.18.0.1/',
    'http://198.51.100.7/',
    'http://203.0.113.9/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://[::]/',
    'http://[::1]/',
    'http://[::7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[::8.8.8.8]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[64:ff9b::8.8.8.8]/',
    'http://[64:ff9b:1::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2001::1]/',
    'http://[2001:db8::1]/',
    'http://[100::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[fec0::1]/',
    'http://[ff02::1]/'
  ])('rejects local or restricted target %s', value => {
    expect(validatePublicHttpUrl(value)).toEqual({
      error: URL_VALIDATION_ERRORS.RESTRICTED_HOST,
      ok: false
    })
  })

  it('expands IPv6 addresses, including an IPv4 tail', () => {
    expect(ipv6Groups('64:ff9b::169.254.169.254')).toEqual([
      0x64, 0xff9b, 0, 0, 0, 0, 0xa9fe, 0xa9fe
    ])
    expect(ipv6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(ipv6Groups('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(ipv6Groups('1::2::3')).toBeNull()
  })
})
