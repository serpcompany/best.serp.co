import { MEDIA_CACHE_CONTROL } from '@serpdirectory/data-ops/media-keys'
import { describe, expect, it } from 'vitest'
import {
  bucketFindings,
  checkMediaHealth,
  type MediaHealthReport,
  type MediaRow,
  mediaHealthMarkdown,
  mediaHealthMarker,
  parseMediaHealthArguments,
  sampleKeys
} from './media-health'
import { fileMediaHealthIssue } from './media-health-issue'
import { RateLimiter } from './r2-objects'

const key = (slug: string, kind = 'logo', hash = '0123456789abcdef') =>
  `best.serp.co/listings/${slug}/${kind}/${hash}.png`
const row = (slug: string, overrides: Partial<MediaRow> = {}): MediaRow => ({
  bytes: 100,
  contentType: 'image/png',
  key: key(slug),
  kind: 'logo',
  live: true,
  slug,
  url: `https://example.com/${slug}.png`,
  ...overrides
})
const listedObject = (overrides = {}) => ({
  cacheControl: MEDIA_CACHE_CONTROL,
  contentType: 'image/png',
  etag: 'aa'.repeat(16),
  size: 100,
  ...overrides
})
/** No waiting in tests: an unlimited limiter and a clock that never sleeps. */
const fast = {
  clock: { now: () => 0, sleep: async () => undefined },
  limiter: new RateLimiter(1_000_000, 1, 1_000_000)
}

describe('media health (#122)', () => {
  it('reports what D1 references that the bucket lacks or holds differently', () => {
    const rows = [
      row('ok'),
      row('missing'),
      row('hotlinked', { key: null }),
      row('foreign', { key: key('someone-else') }),
      row('wrong-kind', { key: key('wrong-kind', 'image') }),
      row('bytes'),
      row('type'),
      row('html'),
      row('cache'),
      row('md5')
    ]
    const listed = new Map([
      [key('ok'), listedObject()],
      [key('bytes'), listedObject({ size: 99 })],
      [key('type'), listedObject({ contentType: 'image/jpeg' })],
      [key('html'), listedObject({ contentType: 'text/html' })],
      [key('cache'), listedObject({ cacheControl: 'no-store' })],
      [key('md5'), listedObject({ etag: 'bb'.repeat(16) })]
    ])
    const md5s = new Map([
      [key('ok'), 'aa'.repeat(16)],
      [key('md5'), 'aa'.repeat(16)]
    ])
    expect(
      bucketFindings(rows, listed, md5s).map(finding => `${finding.slug} ${finding.problem}`)
    ).toEqual([
      'missing missing',
      'hotlinked not_hosted',
      'foreign foreign_key',
      'wrong-kind foreign_key',
      'bytes bytes_mismatch',
      'type content_type_mismatch',
      'html not_an_image',
      'cache cache_control_mismatch',
      'md5 md5_mismatch'
    ])
  })

  it('samples keys evenly and rotates the sample week by week', () => {
    const keys = Array.from({ length: 100 }, (_, index) => `k${String(index).padStart(3, '0')}`)
    const week1 = sampleKeys(keys, 10, 1)
    const week2 = sampleKeys(keys, 10, 2)
    expect(week1).toHaveLength(10)
    expect(new Set(week1).size).toBe(10)
    expect(week1).not.toEqual(week2)
    expect(sampleKeys(keys.slice(0, 3), 10, 5)).toEqual(keys.slice(0, 3))
  })

  it('reads D1 with one SELECT, lists the bucket, and HEADs only the media host', async () => {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
      if (url.startsWith('https://api.cloudflare.com/')) {
        expect(url).toContain('/r2/buckets/cdn/objects?')
        expect(url).toContain('prefix=best.serp.co%2Flisting')
        return Response.json({
          result: [
            {
              etag: '"x"',
              http_metadata: { cacheControl: MEDIA_CACHE_CONTROL, contentType: 'image/png' },
              key: key('alpha'),
              size: 100
            },
            {
              etag: '"x"',
              http_metadata: { cacheControl: MEDIA_CACHE_CONTROL, contentType: 'image/png' },
              key: key('beta'),
              size: 100
            }
          ],
          result_info: { is_truncated: false },
          success: true
        })
      }
      if (url.endsWith(key('beta'))) return new Response(null, { status: 404 })
      return new Response(null, {
        headers: { 'content-length': '100', 'content-type': 'image/png' },
        status: 200
      })
    }) as typeof fetch
    const queries: string[] = []
    const report = await checkMediaHealth(
      'production',
      { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
      {
        fetch: fetcher,
        md5s: new Map(),
        now: () => new Date('2026-10-12T06:17:00.000Z'),
        query: async sql => {
          queries.push(sql)
          return [
            {
              bytes: 100,
              content_type: 'image/png',
              kind: 'logo',
              live: 1,
              media_key: key('alpha'),
              slug: 'alpha',
              url: 'x'
            },
            {
              bytes: 100,
              content_type: 'image/png',
              kind: 'logo',
              live: 1,
              media_key: key('beta'),
              slug: 'beta',
              url: 'x'
            },
            {
              bytes: 100,
              content_type: 'image/png',
              kind: 'logo',
              live: 0,
              media_key: key('gamma'),
              slug: 'gamma',
              url: 'x'
            }
          ]
        },
        r2: fast
      }
    )
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatch(/^SELECT /u)
    expect(calls).toEqual([
      'GET https://api.cloudflare.com/client/v4/accounts/account/r2/buckets/cdn/objects',
      `HEAD https://cdn.serp.co/${key('alpha')}`,
      `HEAD https://cdn.serp.co/${key('beta')}`
    ])
    expect(report).toMatchObject({
      bucket: 'cdn',
      cdnSampled: 2,
      hostedKeys: 3,
      listedObjects: 2,
      rows: 3
    })
    expect(report.findings.map(finding => `${finding.slug} ${finding.problem}`)).toEqual([
      'beta cdn_404',
      'gamma missing'
    ])
    const markdown = mediaHealthMarkdown(report)
    expect(markdown.startsWith(mediaHealthMarker('production'))).toBe(true)
    expect(markdown).toContain('`cdn_404` 1, `missing` 1')
    expect(markdown).toContain(`| \`gamma\` | no | logo | \`missing\` | ${key('gamma')} |`)
  })

  it('accepts exactly an environment, a report path, and a sample size', () => {
    expect(parseMediaHealthArguments(['--', 'production', '--report', 'r.json'])).toEqual({
      environment: 'production',
      report: 'r.json'
    })
    expect(parseMediaHealthArguments(['staging', '--sample', '10'])).toEqual({
      environment: 'staging',
      sample: 10
    })
    for (const argv of [[], ['local'], ['production', '--write'], ['staging', '--sample', 'x']]) {
      expect(() => parseMediaHealthArguments(argv), argv.join(' ')).toThrow(/Usage/u)
    }
  })
})

describe('media health issue (#122)', () => {
  const report = (findings: MediaHealthReport['findings']): MediaHealthReport => ({
    bucket: 'cdn',
    cdnSampled: 1,
    checkedAt: '2026-10-12T06:17:00.000Z',
    environment: 'production',
    findings,
    hostedKeys: 1,
    listedObjects: 1,
    mediaBaseUrl: 'https://cdn.serp.co',
    rows: 1
  })
  const finding = { key: key('alpha'), kind: 'logo', live: true, problem: 'missing', slug: 'alpha' }

  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  function github(
    open: Array<{ body: string; number: number; user: { login: string; type: string } }>
  ) {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace('https://api.github.com', '')
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith('/repos/serpcompany/best.serp.co/issues?')) return Response.json(open)
      return Response.json({ number: 7 })
    }) as typeof fetch
    return { calls, fetcher }
  }

  it('opens an issue for findings, updates the open one, and closes it when clean', async () => {
    const env = { GITHUB_TOKEN: 'token' }
    const marker = mediaHealthMarker('production')
    // Someone else's issue holding the marker is never the report (#123 review S2).
    const fresh = github([
      { body: 'another issue', number: 3, user: bot },
      { body: `${marker}\nplanted`, number: 4, user: { login: 'someone', type: 'User' } },
      { body: `${marker}\nplanted`, number: 5, user: { login: 'github-actions', type: 'User' } }
    ])
    expect(await fileMediaHealthIssue(report([finding]), env, fresh.fetcher)).toEqual({
      action: 'created',
      number: 7
    })
    expect(fresh.calls.at(-1)).toBe('POST /repos/serpcompany/best.serp.co/issues')

    const open = [
      { body: `${marker}\nplanted`, number: 13, user: { login: 'someone', type: 'User' } },
      { body: `${marker}\nold`, number: 12, user: bot }
    ]
    const update = github(open)
    expect(await fileMediaHealthIssue(report([finding]), env, update.fetcher)).toEqual({
      action: 'updated',
      number: 12
    })
    expect(update.calls.at(-1)).toBe('PATCH /repos/serpcompany/best.serp.co/issues/12')

    const close = github(open)
    expect(await fileMediaHealthIssue(report([]), env, close.fetcher)).toEqual({
      action: 'closed',
      number: 12
    })
    expect(close.calls.slice(1)).toEqual([
      'POST /repos/serpcompany/best.serp.co/issues/12/comments',
      'PATCH /repos/serpcompany/best.serp.co/issues/12'
    ])

    const quiet = github([])
    expect(await fileMediaHealthIssue(report([]), env, quiet.fetcher)).toEqual({ action: 'none' })
    expect(quiet.calls).toHaveLength(1)
  })
})
