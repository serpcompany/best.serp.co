import { isHostWithin, urlKey } from '@serpdirectory/utils/url-key'
import { describe, expect, it } from 'vitest'

describe('urlKey (shared website normalization, #62 review finding 4)', () => {
  it('reaches one host for case, trailing dots, percent-encoding, www, and IDN variants', () => {
    for (const website of [
      'https://casino.com/',
      'https://CASINO.com/',
      'https://casino.com./',
      'https://casino.com../',
      'https://casino.com%2E/',
      'https://casino.com.%2e/',
      'https://%63asino.com/',
      'https://www.Casino.COM./',
      'https://ｃａｓｉｎｏ.com/',
      'http://casino.com:8080/path?query#hash'
    ]) {
      expect(urlKey(website), website).toEqual({ blockKey: 'casino.com', hostKey: 'casino.com' })
    }
    expect(urlKey('https://bücher.de/')).toEqual({
      blockKey: 'xn--bcher-kva.de',
      hostKey: 'xn--bcher-kva.de'
    })
    expect(urlKey('https://xn--bcher-kva.de/').hostKey).toBe('xn--bcher-kva.de')
  })

  it('keeps subdomains as their own host but blocks them with their registrable domain', () => {
    expect(urlKey('https://go.casino.com/')).toEqual({
      blockKey: 'casino.com',
      hostKey: 'go.casino.com'
    })
    expect(urlKey('https://www2.casino.com/')).toEqual({
      blockKey: 'casino.com',
      hostKey: 'www2.casino.com'
    })
    expect(urlKey('https://shop.bbc.co.uk/')).toEqual({
      blockKey: 'bbc.co.uk',
      hostKey: 'shop.bbc.co.uk'
    })
  })

  it('treats sites on shared hosts (PSL private section) as separate registrable domains', () => {
    expect(urlKey('https://user.github.io/').blockKey).toBe('user.github.io')
    expect(urlKey('https://docs.user.github.io/').blockKey).toBe('user.github.io')
    expect(urlKey('https://my-app.vercel.app/').blockKey).toBe('my-app.vercel.app')
    // A public suffix itself, or an IP address, is its own block key.
    expect(urlKey('https://github.io/')).toEqual({ blockKey: 'github.io', hostKey: 'github.io' })
    expect(urlKey('https://1.1.1.1/')).toEqual({ blockKey: '1.1.1.1', hostKey: '1.1.1.1' })
  })

  it('removes www. only when the rest is still a registrable host', () => {
    expect(urlKey('https://www.com/').hostKey).toBe('www.com')
    expect(urlKey('https://www.github.io/').hostKey).toBe('www.github.io')
    expect(urlKey('https://www.example.co.uk/').hostKey).toBe('example.co.uk')
  })

  it('refuses an input without a host', () => {
    expect(() => urlKey('not a url')).toThrow()
    expect(() => urlKey('https://./')).toThrow()
  })

  it('matches a host against a block key and its subdomains only', () => {
    expect(isHostWithin('casino.com', 'casino.com')).toBe(true)
    expect(isHostWithin('go.casino.com', 'casino.com')).toBe(true)
    expect(isHostWithin('notcasino.com', 'casino.com')).toBe(false)
    expect(isHostWithin('other.github.io', 'user.github.io')).toBe(false)
  })
})
