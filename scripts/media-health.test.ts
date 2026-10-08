import { describe, expect, it } from 'vitest'
import { MEDIA_CACHE_CONTROL } from '../apps/web/src/db/media-keys'
import {
  bucketFindings,
  checkMediaHealth,
  headFinding,
  MEDIA_HEALTH_USER_AGENT,
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
            },
            {
              etag: '"x"',
              http_metadata: { cacheControl: MEDIA_CACHE_CONTROL, contentType: 'image/png' },
              key: key('delta'),
              size: 100
            }
          ],
          result_info: { is_truncated: false },
          success: true
        })
      }
      if (url.endsWith(key('beta'))) return new Response(null, { status: 404 })
      // Bot protection on the runner (#134): the object is in the bucket, the HEAD is refused.
      if (url.endsWith(key('delta'))) {
        return new Response(null, { headers: { 'cf-mitigated': 'challenge' }, status: 403 })
      }
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
              live: 1,
              media_key: key('delta'),
              slug: 'delta',
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
      `HEAD https://cdn.serp.co/${key('beta')}`,
      `HEAD https://cdn.serp.co/${key('delta')}`
    ])
    expect(report).toMatchObject({
      bucket: 'cdn',
      cdnSampled: 3,
      cdnUnverifiable: [
        { detail: '403, cf-mitigated: challenge', key: key('delta'), kind: 'logo', slug: 'delta' }
      ],
      hostedKeys: 4,
      listedObjects: 3,
      rows: 4
    })
    expect(report.findings.map(finding => `${finding.slug} ${finding.problem}`)).toEqual([
      'beta cdn_404',
      'gamma missing'
    ])
    const markdown = mediaHealthMarkdown(report)
    expect(markdown.startsWith(mediaHealthMarker('production'))).toBe(true)
    expect(markdown).toContain('`cdn_404` 1, `missing` 1')
    expect(markdown).toContain(`| \`gamma\` | no | logo | \`missing\` | ${key('gamma')} |`)
    expect(markdown).not.toContain('`delta`')
    expect(markdown).toContain('1 of 3 HEADs were unverifiable')
  })

  it('counts only answers about the object; a blocked HEAD is unverifiable (#134)', async () => {
    const row = { bytes: 100, contentType: 'image/avif' }
    const answer = (status: number, headers: Record<string, string> = {}) =>
      headFinding(
        'https://cdn.serp.co/x',
        row,
        (async (_url: string | URL | Request, init?: RequestInit) => {
          expect(init?.method).toBe('HEAD')
          expect(new Headers(init?.headers).get('user-agent')).toBe(MEDIA_HEALTH_USER_AGENT)
          return new Response(null, { headers, status })
        }) as typeof fetch,
        fast
      )
    const image = { 'content-length': '100', 'content-type': 'image/avif' }
    expect(await answer(200, image)).toEqual({ status: 'ok' })
    // The first production run (#134): Cloudflare challenged the runner on 11 of 50 HEADs.
    expect(
      await answer(403, {
        'cf-mitigated': 'challenge',
        'content-type': 'text/html',
        server: 'cloudflare'
      })
    ).toEqual({
      detail: '403, cf-mitigated: challenge, Cloudflare HTML page',
      status: 'unverifiable'
    })
    expect(await answer(403)).toEqual({ detail: '403', status: 'unverifiable' })
    expect(await answer(429, { 'retry-after': '3600' })).toEqual({
      detail: '429',
      status: 'unverifiable'
    })
    expect(await answer(200, { ...image, 'cf-mitigated': 'challenge' })).toMatchObject({
      status: 'unverifiable'
    })
    expect(await answer(503)).toEqual({ detail: '503', status: 'unverifiable' })
    // Findings: gone, not an image, or not what D1 recorded.
    expect(await answer(404)).toEqual({ problem: 'cdn_404', status: 'finding' })
    expect(await answer(200, { 'content-type': 'text/html' })).toEqual({
      detail: 'text/html',
      problem: 'cdn_not_an_image',
      status: 'finding'
    })
    expect(await answer(200, { ...image, 'content-type': 'image/png' })).toMatchObject({
      problem: 'cdn_content_type'
    })
    expect(await answer(200, { ...image, 'content-length': '99' })).toMatchObject({
      problem: 'cdn_bytes'
    })
    // No answer after three tries is unverifiable, not a failed run.
    let calls = 0
    const down = await headFinding(
      'https://cdn.serp.co/x',
      row,
      (async () => {
        calls += 1
        throw new TypeError('fetch failed')
      }) as typeof fetch,
      fast
    )
    expect(calls).toBe(3)
    expect(down).toEqual({ detail: 'no answer: fetch failed', status: 'unverifiable' })
  })

  it('reports unverifiable HEADs in the summary only, and warns when they are many', () => {
    const base: MediaHealthReport = {
      bucket: 'cdn',
      cdnSampled: 50,
      cdnUnverifiable: Array.from({ length: 11 }, (_, index) => ({
        detail: '403, cf-mitigated: challenge',
        key: key(`s${index}`),
        kind: 'logo',
        slug: `s${index}`
      })),
      checkedAt: '2026-10-12T06:17:00.000Z',
      environment: 'production',
      findings: [],
      hostedKeys: 3747,
      listedObjects: 3747,
      mediaBaseUrl: 'https://cdn.serp.co',
      rows: 3747
    }
    const markdown = mediaHealthMarkdown(base)
    expect(markdown).toContain('11 of 50 HEADs were unverifiable')
    expect(markdown).toContain('403, cf-mitigated: challenge ×11')
    expect(markdown).toContain('**Warning:** 22% of the CDN sample was unverifiable')
    expect(markdown).toContain('No missing or mismatched objects.')
    const few = mediaHealthMarkdown({ ...base, cdnUnverifiable: base.cdnUnverifiable.slice(0, 2) })
    expect(few).toContain('2 of 50 HEADs were unverifiable')
    expect(few).not.toContain('**Warning:**')
    expect(mediaHealthMarkdown({ ...base, cdnUnverifiable: [] })).not.toContain('unverifiable')
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
    cdnUnverifiable: [],
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
