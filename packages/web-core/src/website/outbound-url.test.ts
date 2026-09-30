import { describe, expect, it } from 'vitest'
import { getOutboundUrlWithRef } from './outbound-url'

const serpDirectoryConfig = {
  domain: 'serpdownloaders.com',
  publicUrl: 'https://serpdownloaders.com'
}

describe('getOutboundUrlWithRef', () => {
  it('adds the directory ref to a plain outbound URL', () => {
    expect(getOutboundUrlWithRef('https://example.com', serpDirectoryConfig)).toBe(
      'https://example.com/?ref=serpdownloaders.com'
    )
  })

  it('appends the directory ref after existing query parameters', () => {
    expect(getOutboundUrlWithRef('https://example.com/pricing?plan=pro', serpDirectoryConfig)).toBe(
      'https://example.com/pricing?plan=pro&ref=serpdownloaders.com'
    )
  })

  it('preserves hash fragments after adding the directory ref', () => {
    expect(getOutboundUrlWithRef('https://example.com/pricing#buy', serpDirectoryConfig)).toBe(
      'https://example.com/pricing?ref=serpdownloaders.com#buy'
    )
  })

  it('does not overwrite an existing ref parameter', () => {
    expect(
      getOutboundUrlWithRef('https://example.com/pricing?ref=partner#buy', serpDirectoryConfig)
    ).toBe('https://example.com/pricing?ref=partner#buy')
  })

  it('returns the original URL when destination parsing fails', () => {
    expect(getOutboundUrlWithRef('not a url', serpDirectoryConfig)).toBe('not a url')
  })

  it('uses the public URL hostname when the configured domain is unavailable', () => {
    expect(
      getOutboundUrlWithRef('https://example.com', {
        domain: '',
        publicUrl: 'https://directory.example'
      })
    ).toBe('https://example.com/?ref=directory.example')
  })

  it('prefers the configured domain over the public URL hostname', () => {
    expect(
      getOutboundUrlWithRef('https://example.com', {
        domain: 'configured.example',
        publicUrl: 'https://public.example'
      })
    ).toBe('https://example.com/?ref=configured.example')
  })

  it('returns the original URL when the ref domain cannot be resolved', () => {
    expect(
      getOutboundUrlWithRef('https://example.com', {
        domain: '',
        publicUrl: 'not a url'
      })
    ).toBe('https://example.com')
  })
})
