import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, parseManifest } from './d1-publisher.ts'
import {
  buildDownloaderLinksManifest,
  CHECKED_LINK,
  type CheckedLink,
  checkVerdict,
  committedRetirements,
  DOWNLOADER_LINKS_MANIFEST_ID,
  downloaderLinkOperations,
  type ListingLinks,
  readDownloaderLinksInputs
} from './downloader-links-manifest.ts'

const store = (slug: string, item: string) =>
  `https://chromewebstore.google.com/detail/${slug}/${item}`
const ITEM_A = 'a'.repeat(32)
const ITEM_B = 'b'.repeat(32)
const checks: CheckedLink[] = [
  { url: 'https://github.com/serpapps/live', status: 200, githubApi: 200, verdict: 'ok' },
  {
    url: 'https://github.com/serpapps/live/releases/latest',
    status: 302,
    githubApi: 200,
    final: { status: 200, url: 'https://github.com/serpapps/live/releases/tag/v1.0.0' },
    verdict: 'ok'
  },
  { url: 'https://github.com/serpapps/deleted', status: 404, githubApi: 404, verdict: 'dead' },
  {
    url: 'https://github.com/serpapps/old-name',
    status: 404,
    githubApi: 404,
    verdict: 'dead',
    replacement: { url: 'https://github.com/serpapps/new-name', status: 200, githubApi: 200 }
  },
  { url: 'https://www.producthunt.com/products/gone', status: 404, verdict: 'dead' },
  {
    url: store('old-name', ITEM_A),
    status: 301,
    final: { status: 200, url: store('downloader-for-a', ITEM_A), title: 'Downloader for A' },
    verdict: 'renamed'
  },
  {
    url: store('removed', ITEM_B),
    status: 301,
    final: { status: 200, url: store('empty-title', ITEM_B), title: 'Chrome Web Store' },
    verdict: 'removed'
  }
]
const link = (label: string, url: string) => ({ label, url })
const install = (slug: string) => link('Install browser extension', `https://serp.ly/${slug}`)
const listings: ListingLinks[] = [
  {
    id: 'lst_bbbbbbbbbbbb',
    slug: 'b-downloader',
    links: [
      install('b'),
      link('GitHub repository', 'https://github.com/serpapps/old-name'),
      link('Product Hunt', 'https://www.producthunt.com/products/gone'),
      link('Chrome Web Store', store('old-name', ITEM_A))
    ]
  },
  {
    id: 'lst_aaaaaaaaaaaa',
    slug: 'a-downloader',
    links: [
      install('a'),
      link('GitHub repository', 'https://github.com/serpapps/deleted'),
      link('SERP Apps', 'https://apps.serp.co/a'),
      link('Chrome Web Store', store('removed', ITEM_B))
    ]
  },
  {
    id: 'lst_cccccccccccc',
    slug: 'c-downloader',
    links: [
      link('GitHub repository', 'https://github.com/serpapps/live'),
      link('Latest Release', 'https://github.com/serpapps/live/releases/latest')
    ]
  },
  {
    id: 'lst_dddddddddddd',
    slug: 'd-downloader',
    links: [install('d'), link('GitHub repository', 'https://github.com/serpapps/deleted')]
  }
]
const retired = new Map([['lst_dddddddddddd', 'd-downloader']])
const committed = () =>
  readFileSync(resolve('d1/publications', `${DOWNLOADER_LINKS_MANIFEST_ID}.yaml`), 'utf8')

describe('the downloader links manifest (#376)', () => {
  it('removes dead and removed links, moves the replaced and renamed in place, and keeps the rest', () => {
    const { operations, leftAlone } = downloaderLinkOperations(checks, listings, retired)
    expect(operations).toEqual([
      {
        action: 'listing-resources-set',
        id: 'lst_aaaaaaaaaaaa',
        slug: 'a-downloader',
        reason:
          '#376: removes a link to a deleted GitHub repository, removes a Chrome Web Store link to a removed item; evidence in d1/hygiene/2026-10-11-downloader-links.yaml',
        expected: listings[1]?.links,
        resources: [install('a'), link('SERP Apps', 'https://apps.serp.co/a')]
      },
      {
        action: 'listing-resources-set',
        id: 'lst_bbbbbbbbbbbb',
        slug: 'b-downloader',
        reason:
          '#376: removes a Product Hunt link that answers 404, points a Chrome Web Store link at its renamed URL, points a GitHub link at the live repository; evidence in d1/hygiene/2026-10-11-downloader-links.yaml',
        expected: listings[0]?.links,
        resources: [
          install('b'),
          link('GitHub repository', 'https://github.com/serpapps/new-name'),
          link('Chrome Web Store', store('downloader-for-a', ITEM_A))
        ]
      }
    ])
    // c's links all answer; d is one #337 retires, left alone as #376 says of whop-downloader.
    expect(leftAlone).toEqual(['d-downloader'])
    // Without the retirement, d is fixed like any other.
    expect(
      downloaderLinkOperations(checks, listings).operations.map(operation => operation.slug)
    ).toEqual(['a-downloader', 'b-downloader', 'd-downloader'])
  })

  it.each<[string, CheckedLink]>([
    [
      'ok without a 200',
      { url: 'https://github.com/serpapps/x', status: 404, githubApi: 404, verdict: 'ok' }
    ],
    [
      'ok on a repository the API misses',
      { url: 'https://github.com/serpapps/x', status: 200, githubApi: 404, verdict: 'ok' }
    ],
    [
      'a GitHub link without githubApi',
      { url: 'https://github.com/serpapps/x', status: 404, verdict: 'dead' }
    ],
    [
      'dead with a 200',
      { url: 'https://www.producthunt.com/products/x', status: 200, verdict: 'dead' }
    ],
    [
      'dead with a repository the API finds',
      { url: 'https://github.com/serpapps/x', status: 404, githubApi: 200, verdict: 'dead' }
    ],
    [
      'a replacement that does not answer',
      {
        url: 'https://github.com/serpapps/x',
        status: 404,
        githubApi: 404,
        verdict: 'dead',
        replacement: { url: 'https://github.com/serpapps/y', status: 404, githubApi: 404 }
      }
    ],
    [
      'a replacement on a link that is not dead',
      {
        url: store('renamed', ITEM_A),
        status: 301,
        final: { status: 200, url: store('new', ITEM_A) },
        verdict: 'renamed',
        replacement: { url: 'https://github.com/serpapps/y', status: 200, githubApi: 200 }
      }
    ],
    [
      'renamed to another item',
      {
        url: store('x', ITEM_A),
        status: 301,
        final: { status: 200, url: store('y', ITEM_B) },
        verdict: 'renamed'
      }
    ],
    [
      'renamed to the generic page',
      {
        url: store('x', ITEM_A),
        status: 301,
        final: { status: 200, url: store('empty-title', ITEM_A) },
        verdict: 'renamed'
      }
    ],
    [
      'removed without the generic page',
      { url: store('x', ITEM_A), status: 200, verdict: 'removed' }
    ],
    [
      'a link the check does not cover',
      { url: 'https://github.com/other/x', status: 404, githubApi: 404, verdict: 'dead' }
    ]
  ])('refuses a verdict its responses do not support: %s', (_name, check) => {
    expect(() => checkVerdict(check)).toThrow()
  })

  it('refuses a check twice, a listing twice, an unchecked link, a stale check, and a moved retirement', () => {
    expect(() => downloaderLinkOperations([...checks, checks[0] as CheckedLink], listings)).toThrow(
      /checked twice/u
    )
    expect(() =>
      downloaderLinkOperations(checks, [...listings, listings[2] as ListingLinks])
    ).toThrow(/listed twice/u)
    expect(() =>
      downloaderLinkOperations(checks, [
        ...listings,
        {
          id: 'lst_eeeeeeeeeeee',
          slug: 'e-downloader',
          links: [link('GitHub', 'https://github.com/serpapps/e')]
        }
      ])
    ).toThrow(/e-downloader: no check names https:\/\/github\.com\/serpapps\/e/u)
    expect(() => downloaderLinkOperations(checks, listings.slice(0, 2))).toThrow(
      /No listing carries https:\/\/github\.com\/serpapps\/live/u
    )
    expect(() =>
      downloaderLinkOperations(checks, listings, new Map([['lst_dddddddddddd', 'd-renamed']]))
    ).toThrow(/retired under another slug/u)
  })

  it('keeps the committed manifest identical to what the checks generate', () => {
    const { checks: recorded, listings: live, retired: duplicates } = readDownloaderLinksInputs()
    expect(committed()).toBe(buildDownloaderLinksManifest(recorded, live, duplicates))
  })

  it("carries out #376's defaults on every link the check covers", () => {
    const { checks: recorded, listings: live, retired: duplicates } = readDownloaderLinksInputs()
    const manifest = parseManifest(committed())
    expect(manifest).toMatchObject({ concurrency: 'rows', id: DOWNLOADER_LINKS_MANIFEST_ID })
    const operations = manifest.operations.flatMap(operation =>
      operation.action === 'listing-resources-set' ? [operation] : []
    )
    expect(operations).toHaveLength(manifest.operations.length)
    expect(operations.map(operation => operation.slug)).toEqual([
      'adobe-stock-downloader',
      'alamy-downloader',
      'circle-downloader',
      'coursera-downloader',
      'deviantart-downloader',
      'getty-images-downloader',
      'gohighlevel-downloader',
      'hulu-downloader',
      'internet-archive-downloader',
      'loom-video-downloader',
      'mindvalley-downloader',
      'moodle-downloader',
      'netflix-downloader',
      'nicovideo-downloader',
      'pexels-video-downloader',
      'podia-downloader',
      'rawpixel-downloader',
      'skillshare-downloader',
      'skool-video-downloader',
      'snapchat-video-downloader',
      'teachable-video-downloader',
      'terabox-downloader',
      'thumbnail-downloader',
      'tiktok-downloader',
      'twitch-video-downloader',
      'twitter-x-downloader',
      'udemy-downloader',
      'unsplash-downloader',
      'vectorstock-downloader',
      'whop-video-downloader',
      'wistia-video-downloader'
    ])
    // #337 retires 14 duplicates, whop-downloader and seven more downloaders among them: none is
    // touched, and four would have changed.
    expect(duplicates.size).toBe(14)
    expect([...duplicates.values()].filter(slug => slug.endsWith('-downloader')).sort()).toEqual([
      'facebook-downloader',
      'kajabi-downloader',
      'loom-downloader',
      'skool-downloader',
      'sprout-downloader',
      'vimeo-downloader',
      'whop-downloader',
      'wistia-downloader'
    ])
    expect(downloaderLinkOperations(recorded, live, duplicates).leftAlone).toEqual([
      'loom-downloader',
      'skool-downloader',
      'whop-downloader',
      'wistia-downloader'
    ])
    for (const operation of operations) expect(duplicates.has(operation.id)).toBe(false)
    // The listings and their links are the recorded ones, and each check covers what it claims.
    const recordedById = new Map(live.map(listing => [listing.id, listing]))
    const byUrl = new Map(recorded.map(check => [check.url, check]))
    for (const operation of operations) {
      expect(operation.expected, operation.slug).toEqual(recordedById.get(operation.id)?.links)
      // Every covered link left on the page answers: an ok check, a renamed item's final URL, or a
      // live replacement; nothing else on the page changes, in order.
      const answering = new Set(
        recorded.flatMap(check =>
          check.verdict === 'ok'
            ? [check.url]
            : check.verdict === 'renamed'
              ? [check.final?.url ?? '']
              : check.replacement
                ? [check.replacement.url]
                : []
        )
      )
      for (const resource of operation.resources.filter(item => CHECKED_LINK.test(item.url)))
        expect(answering.has(resource.url), `${operation.slug}: ${resource.url}`).toBe(true)
      expect(operation.resources.filter(item => !CHECKED_LINK.test(item.url))).toEqual(
        operation.expected.filter(item => !CHECKED_LINK.test(item.url))
      )
      for (const resource of operation.expected.filter(item => CHECKED_LINK.test(item.url)))
        expect(byUrl.get(resource.url), resource.url).toBeDefined()
    }
    // The two live repositories #376 names.
    const resourcesOf = (slug: string) =>
      operations.find(operation => operation.slug === slug)?.resources.map(item => item.url)
    expect(resourcesOf('twitter-x-downloader')).toContain(
      'https://github.com/serpapps/twitter-x-downloader'
    )
    expect(resourcesOf('mindvalley-downloader')).toContain(
      'https://github.com/serpapps/mindvalley-downloader/releases/latest'
    )
    // The removed store items (udemy, tiktok) and the Product Hunt 404 leave every page.
    const left = operations.flatMap(operation => operation.resources.map(item => item.url))
    for (const check of recorded.filter(
      item => item.verdict === 'removed' || (item.verdict === 'dead' && !item.replacement)
    ))
      expect(left, check.url).not.toContain(check.url)
    expect(recorded.filter(item => item.verdict === 'removed').map(item => item.url)).toEqual([
      'https://chromewebstore.google.com/detail/tiktok-downloader/apkldlbgpmenoilgjldmbkipidboplae',
      'https://chromewebstore.google.com/detail/udemy-downloader/ecbbfcaojpjlnpeabmdmggbffdlghjjk'
    ])
  })

  it('applies on the recorded links at any version, refuses a listing that changed, and applies once', () => {
    const { listings: live } = readDownloaderLinksInputs()
    const source = committed()
    const manifest = parseManifest(source)
    const db = new DatabaseSync(':memory:')
    for (const migration of freshMigrationNames())
      db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    const now = '2026-10-11T00:00:00.000Z'
    db.exec(`INSERT INTO categories (slug,name) VALUES ('downloaders','Downloaders');
      INSERT INTO publication_state (id,version,checksum,published_at) VALUES (1,41,'${'a'.repeat(64)}','${now}')`)
    const insertListing = db.prepare(
      "INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum) VALUES (?,?,?,'d',?,'draft',?,'test','fixture',?)"
    )
    const file = db.prepare(
      "INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,0,1 FROM categories WHERE slug='downloaders'"
    )
    const insertLink = db.prepare(
      'INSERT INTO listing_resource_links (listing_id,label,url,sort_order) VALUES (?,?,?,?)'
    )
    for (const item of live) {
      insertListing.run(
        item.id,
        item.slug,
        item.slug,
        `https://serp.ly/${item.slug}`,
        now,
        'c'.repeat(64)
      )
      file.run(item.id)
      for (const [order, entry] of item.links.entries())
        insertLink.run(item.id, entry.label, entry.url, order)
    }
    db.exec("UPDATE listings SET status='approved'")
    const linksOf = (id: string) =>
      db
        .prepare(
          'SELECT label,url FROM listing_resource_links WHERE listing_id=? ORDER BY sort_order'
        )
        .all(id)
    const apply = (text: string) => {
      const state = db
        .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
        .get() as {
        checksum: string
        version: number
      }
      const plan = buildPublicationPlan(parseManifest(text), text, now, state)
      expect(plan.statements.length).toBeLessThanOrEqual(2000)
      db.exec('BEGIN')
      try {
        for (const statement of plan.statements) {
          assertD1StatementLimits(statement.query, statement.bindings)
          db.prepare(statement.query).run(...(statement.bindings as SQLInputValue[]))
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const snapshot = () =>
      db
        .prepare(
          'SELECT listing_id,label,url,sort_order FROM listing_resource_links ORDER BY listing_id,sort_order'
        )
        .all()

    // A listing whose links changed since the check refuses the whole batch, writing nothing.
    const edited = live.find(item => item.slug === 'wistia-video-downloader')?.id
    db.prepare(
      "UPDATE listing_resource_links SET url='https://example.com/edited' WHERE listing_id=? AND sort_order=0"
    ).run(edited ?? '')
    const before = snapshot()
    expect(() => apply(source)).toThrow(
      /listing-resources-set wistia-video-downloader: the listing is not approved, or its slug or links changed since the manifest/u
    )
    expect(snapshot()).toEqual(before)
    db.prepare(
      "UPDATE listing_resource_links SET url='https://serp.ly/wistia-video-downloader' WHERE url='https://example.com/edited'"
    ).run()

    apply(source)
    const byId = new Map(live.map(item => [item.id, item]))
    const changed = new Set<string>()
    for (const operation of manifest.operations) {
      if (operation.action !== 'listing-resources-set') continue
      changed.add(operation.id)
      expect(linksOf(operation.id), operation.slug).toEqual(operation.resources)
    }
    // Every other listing, the retired duplicates among them, keeps its links exactly.
    for (const item of live)
      if (!changed.has(item.id))
        expect(linksOf(item.id), item.slug).toEqual(byId.get(item.id)?.links)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM listing_events WHERE event_type='edited'").get()
    ).toEqual({ count: changed.size })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 42
    })
    // Applied once: a second run (under another id) finds the links changed and writes nothing.
    const again = source.replace(`id: ${DOWNLOADER_LINKS_MANIFEST_ID}`, 'id: 2026-10-11-again')
    const applied = snapshot()
    expect(() => apply(again)).toThrow(/its slug or links changed since the manifest/u)
    expect(snapshot()).toEqual(applied)
  })

  it('reads #337’s retirements from its committed manifest', () => {
    expect(committedRetirements().get('lst_eb9f9e91aa46a4e661aeb2e4')).toBe('whop-downloader')
  })
})
