import { resolveCheckedInSiteConfig } from '@serpdirectory/site-contract'
import { activeCheckedInSiteIds } from '@serpdirectory/site-contract/active-site-ids'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSitemapTargets, runSubmitGscSitemaps } from './submit-gsc-sitemaps.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getSitemapTargets', () => {
  it('derives canonical sitemap targets from active checked-in site config', () => {
    expect(getSitemapTargets()).toEqual(
      activeCheckedInSiteIds.map(siteId => {
        const siteConfig = resolveCheckedInSiteConfig(siteId)

        return {
          domain: siteConfig.site.domain,
          sitemapUrl: `${siteConfig.site.publicUrl}/sitemap-index.xml`
        }
      })
    )
  })

  it('can scope canonical sitemap targets to specific site ids', () => {
    expect(getSitemapTargets(['serp.software'])).toEqual([
      {
        domain: 'serp.software',
        sitemapUrl: 'https://serp.software/sitemap-index.xml'
      }
    ])
  })
})

describe('runSubmitGscSitemaps', () => {
  it('verifies credential authority with a read-only Search Console request', async () => {
    const calls: Array<{ headers: Headers; method: string; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          headers: new Headers(init?.headers),
          method: init?.method ?? 'GET',
          url
        })
        return new Response('{"siteEntry":[]}', { status: 200 })
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(['--verify-credentials'], {
      GSC_ACCESS_TOKEN: 'token',
      GSC_QUOTA_PROJECT: 'quota-project'
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe('https://www.googleapis.com/webmasters/v3/sites')
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer token')
    expect(calls[0]?.headers.get('x-goog-user-project')).toBe('quota-project')
    expect(log).toHaveBeenCalledWith(
      'Verified Search Console credential authority without mutation.'
    )
  })

  it('prints canonical submit operations during dry-run without credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(['--dry-run', '--site', 'serp.software'], {})

    expect(log).toHaveBeenCalledWith(
      'SUBMIT https://serp.software/ -> https://serp.software/sitemap-index.xml'
    )
  })

  it('prints all active canonical submit operations during dry-run by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(['--dry-run'], {})

    expect(log).toHaveBeenCalledTimes(activeCheckedInSiteIds.length)
    expect(log).toHaveBeenCalledWith(
      'SUBMIT https://serp.software/ -> https://serp.software/sitemap-index.xml'
    )
  })

  it('can scope canonical submit operations from the workflow site id env', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(['--dry-run'], {
      GSC_SITE_IDS: 'serp.software'
    })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      'SUBMIT https://serp.software/ -> https://serp.software/sitemap-index.xml'
    )
  })

  it('lists registered sitemaps without mutation', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url
        })
        return new Response(
          JSON.stringify({
            sitemap: [
              {
                isPending: false,
                isSitemapsIndex: true,
                lastSubmitted: '2026-07-30T00:00:00Z',
                path: 'https://serp.software/sitemap-index.xml'
              }
            ]
          }),
          { status: 200 }
        )
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(['--list-sitemaps', '--site', 'serp.software'], {
      GSC_ACCESS_TOKEN: 'token'
    })

    expect(calls).toEqual([
      {
        method: 'GET',
        url: 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fserp.software%2F/sitemaps'
      }
    ])
    expect(log).toHaveBeenCalledWith(
      'SITEMAP https://serp.software/ -> https://serp.software/sitemap-index.xml ' +
        '(index=true, pending=false, lastSubmitted=2026-07-30T00:00:00Z)'
    )
  })

  it('prints delete operations for stale sitemap URLs during dry-run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(
      ['--dry-run', '--no-submit', '--delete-sitemap', 'https://serp.software/pages-sitemap.xml'],
      {}
    )

    expect(log).toHaveBeenCalledWith(
      'DELETE https://serp.software/ -> https://serp.software/pages-sitemap.xml'
    )
  })

  it('submits canonical sitemaps after deleting stale sitemap URLs', async () => {
    const calls: Array<{ method: string; url: string }> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url
      })

      return new Response('{}', {
        status: 200
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(
      ['--site', 'serp.software', '--delete-sitemap', 'https://serp.software/pages-sitemap.xml'],
      {
        GSC_ACCESS_TOKEN: 'token'
      }
    )

    expect(calls.map(call => call.method)).toEqual(['DELETE', 'PUT'])
    expect(calls[0]?.url).toContain(
      '/sites/https%3A%2F%2Fserp.software%2F/sitemaps/https%3A%2F%2Fserp.software%2Fpages-sitemap.xml'
    )
    expect(calls[1]?.url).toContain(
      '/sites/https%3A%2F%2Fserp.software%2F/sitemaps/https%3A%2F%2Fserp.software%2Fsitemap-index.xml'
    )
    expect(log).toHaveBeenCalledWith(
      'Deleted https://serp.software/pages-sitemap.xml for https://serp.software/'
    )
    expect(log).toHaveBeenCalledWith(
      'Submitted https://serp.software/sitemap-index.xml for https://serp.software/'
    )
  })

  it('uses configured GSC site URL mappings for delete and submit calls', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return new Response('{}', { status: 200 })
      })
    )

    await runSubmitGscSitemaps(
      ['--site', 'serp.software', '--delete-sitemap', 'https://serp.software/pages-sitemap.xml'],
      {
        GSC_ACCESS_TOKEN: 'token',
        GSC_SITE_URL_MAP: JSON.stringify({
          'serp.software': 'sc-domain:serp.software'
        })
      }
    )

    expect(calls.every(url => url.includes('/sites/sc-domain%3Aserp.software/'))).toBe(true)
  })

  it('treats already-deleted stale sitemap URLs as successful deletes', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? 'GET',
          url
        })

        return new Response('{}', {
          status: init?.method === 'DELETE' ? 404 : 200
        })
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await runSubmitGscSitemaps(
      ['--site', 'serp.software', '--delete-sitemap', 'https://serp.software/pages-sitemap.xml'],
      {
        GSC_ACCESS_TOKEN: 'token'
      }
    )

    expect(calls.map(call => call.method)).toEqual(['DELETE', 'PUT'])
    expect(log).toHaveBeenCalledWith(
      'Deleted https://serp.software/pages-sitemap.xml for https://serp.software/'
    )
  })
})
