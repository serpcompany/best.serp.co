import { isHostBlocked, urlKey, websiteSpellings } from '@serpdirectory/utils/url-key'
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
      expect(urlKey(website), website).toEqual({
        blockKey: 'casino.com',
        coversSubdomains: true,
        hostKey: 'casino.com'
      })
    }
    expect(urlKey('https://bücher.de/')).toEqual({
      blockKey: 'xn--bcher-kva.de',
      coversSubdomains: true,
      hostKey: 'xn--bcher-kva.de'
    })
    expect(urlKey('https://xn--bcher-kva.de/').hostKey).toBe('xn--bcher-kva.de')
  })

  it('keeps subdomains as their own host but blocks them with their registrable domain', () => {
    expect(urlKey('https://go.casino.com/')).toEqual({
      blockKey: 'casino.com',
      coversSubdomains: true,
      hostKey: 'go.casino.com'
    })
    expect(urlKey('https://www2.casino.com/')).toEqual({
      blockKey: 'casino.com',
      coversSubdomains: true,
      hostKey: 'www2.casino.com'
    })
    expect(urlKey('https://shop.bbc.co.uk/')).toEqual({
      blockKey: 'bbc.co.uk',
      coversSubdomains: true,
      hostKey: 'shop.bbc.co.uk'
    })
  })

  it('treats sites on shared hosts (PSL private section) as separate registrable domains', () => {
    expect(urlKey('https://user.github.io/').blockKey).toBe('user.github.io')
    expect(urlKey('https://docs.user.github.io/').blockKey).toBe('user.github.io')
    expect(urlKey('https://my-app.vercel.app/').blockKey).toBe('my-app.vercel.app')
    // A public suffix itself, or an IP address, is its own block key, for that exact host only.
    expect(urlKey('https://github.io/')).toEqual({
      blockKey: 'github.io',
      coversSubdomains: false,
      hostKey: 'github.io'
    })
    expect(urlKey('https://1.1.1.1/')).toEqual({
      blockKey: '1.1.1.1',
      coversSubdomains: false,
      hostKey: '1.1.1.1'
    })
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

  it('matches a host against a block by its scope', () => {
    const domain = { coversSubdomains: true, key: 'casino.com' }
    expect(isHostBlocked('casino.com', domain)).toBe(true)
    expect(isHostBlocked('go.casino.com', domain)).toBe(true)
    expect(isHostBlocked('notcasino.com', domain)).toBe(false)
    const suffix = { coversSubdomains: false, key: 'github.io' }
    expect(isHostBlocked('github.io', suffix)).toBe(true)
    expect(isHostBlocked('unrelated-user.github.io', suffix)).toBe(false)
  })

  it('spells one website the ways the already-listed check matches (#64 review)', () => {
    const root = websiteSpellings('https://new.example/')
    expect(root).toEqual(
      expect.arrayContaining([
        'https://new.example',
        'https://new.example/',
        'https://www.new.example',
        'https://www.new.example/',
        'http://new.example',
        'http://www.new.example/'
      ])
    )
    expect(root).toHaveLength(8)
    // Every spelling of the same website gives the same set.
    for (const website of [
      'https://new.example',
      'http://WWW.New.Example/',
      'https://new.example./'
    ]) {
      expect(new Set(websiteSpellings(website)), website).toEqual(new Set([...root, website]))
    }
    // A path keeps its own spellings, with its query; another path is another website.
    const path = websiteSpellings('https://www.serp.ly/tool/?ref=1')
    expect(path).toEqual(
      expect.arrayContaining(['https://serp.ly/tool?ref=1', 'http://www.serp.ly/tool/?ref=1'])
    )
    expect(path).not.toContain('https://serp.ly/?ref=1')
    expect(websiteSpellings('https://serp.ly/other')).not.toContain('https://serp.ly/tool')
    expect(websiteSpellings('https://example.com:8443/')).toContain('https://www.example.com:8443')
  })
})
