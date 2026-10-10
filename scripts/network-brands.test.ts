import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { site } from '../apps/web/src/lib/site'
import {
  ADDED_NETWORK_BRANDS,
  getNetworkBrands,
  NETWORK_BRANDS_SOURCE,
  parseNetworkBrands,
  type RawNetworkBrandsData,
  SELF_HOSTNAMES,
  selectNetworkBrands
} from '../apps/web/src/lib/site/network-brands'
import { project } from './project'

/**
 * `/brands/` (serpcompany/best.serp.co#193): devinschumacher.com's list, plus devinschumacher.com,
 * without this site, with no adult EMD and no hosted mirror.
 */

const sourceCopyPath = resolve(
  project.appDirectory,
  'src/lib/site/data/devinschumacher-com-brands.json'
)

/**
 * Sibling checkouts (docs/harness.md, "Sibling checkouts"). The comparisons read a recorded
 * commit, never a working tree, and skip when the checkout or the commit is missing (CI).
 */
const reposRoot = process.env.SERP_REPOS_ROOT ?? resolve(homedir(), 'dev/repos')
/** serpcompany/serp `main` when this list was decided (2026-10-09). */
const SHARED_BRAND_DATA_COMMIT = 'd13fa4c0d55a83af32029a5363f940748eada135'

function fileAtCommit(repository: string, commit: string, path: string): string | undefined {
  const checkout = resolve(reposRoot, repository)
  if (!existsSync(checkout)) return undefined
  try {
    return execFileSync('git', ['-C', checkout, 'show', `${commit}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return undefined
  }
}

const sourceAtCommit = fileAtCommit(
  'devinschumacher.com',
  NETWORK_BRANDS_SOURCE.commit,
  NETWORK_BRANDS_SOURCE.path
)
const sharedBrands = fileAtCommit(
  'serp',
  SHARED_BRAND_DATA_COMMIT,
  'workers/brands-page/data/brands.json'
)
const sharedBrandSets = fileAtCommit(
  'serp',
  SHARED_BRAND_DATA_COMMIT,
  'workers/brands-page/data/brand-sets.json'
)

const sourceCopy = JSON.parse(readFileSync(sourceCopyPath, 'utf8')) as RawNetworkBrandsData
const sourceBrands = Object.values(sourceCopy.brands ?? {})
const brands = getNetworkBrands()

describe('/brands/ data source (#193)', () => {
  it('renders the copy of the list devinschumacher.com/brands/ renders', () => {
    expect(brands).toEqual(selectNetworkBrands(sourceCopy))
  })

  it.runIf(sourceAtCommit !== undefined)(
    'keeps the copy identical to the recorded devinschumacher.com commit',
    () => {
      expect(
        readFileSync(sourceCopyPath, 'utf8'),
        `${sourceCopyPath} must equal ${NETWORK_BRANDS_SOURCE.repository}'s ${NETWORK_BRANDS_SOURCE.path} at ${NETWORK_BRANDS_SOURCE.commit}`
      ).toBe(sourceAtCommit)
    }
  )

  it("lists the source's brands without this site, plus devinschumacher.com", () => {
    const listed = sourceBrands.filter(
      brand => !SELF_HOSTNAMES.has(new URL(brand.url ?? '').hostname)
    )
    expect(listed.length).toBe(sourceBrands.length - 1)
    expect(brands).toHaveLength(listed.length + 1)
    for (const brand of [...listed, ...Object.values(ADDED_NETWORK_BRANDS)]) {
      expect(brands).toContainEqual(expect.objectContaining({ name: brand.name, url: brand.url }))
    }
    expect(brands.map(({ name, url }) => [name, url])).toEqual([
      ['Boxing Undefeated', 'https://boxingundefeated.com'],
      ['BrowserExtensions.io', 'https://browserextensions.io'],
      ['Devin Schumacher', 'https://devinschumacher.com'],
      ['Keybumps', 'https://keybumps.app'],
      ['SERP', 'https://serp.co'],
      ['SERP AI', 'https://serp.ai'],
      ['SERP Apps', 'https://apps.serp.co'],
      ['SERP DR', 'https://dr.serp.co'],
      ['SERP Extensions', 'https://extensions.serp.co'],
      ['SERP Games', 'https://games.serp.co'],
      ['SERP Lists', 'https://serplists.com'],
      ['SERP Tools', 'https://tools.serp.co'],
      ['Zenbu Japanese', 'https://zenbujapanese.com']
    ])
  })
})

describe('/brands/ list rules (#193)', () => {
  it('never links to this site', () => {
    expect(SELF_HOSTNAMES.has(site.site.domain)).toBe(true)
    expect(brands.filter(brand => SELF_HOSTNAMES.has(brand.hostname))).toEqual([])
  })

  it('lists no hosted mirror such as a *.pages.dev deployment', () => {
    expect(
      brands.filter(brand => /\.(?:pages\.dev|vercel\.app|netlify\.app)$/u.test(brand.hostname))
    ).toEqual([])
  })

  it.runIf(sharedBrands !== undefined && sharedBrandSets !== undefined)(
    'lists no brand the shared brand data marks as adult',
    () => {
      const shared = JSON.parse(sharedBrands ?? '') as {
        brands: Record<string, { isAdult?: boolean; url: string }>
      }
      const { brandSets } = JSON.parse(sharedBrandSets ?? '') as {
        brandSets: Record<string, string[]>
      }
      const adultOnly = new Set(brandSets.adultsOnly)
      const adultHostnames = new Set(
        Object.entries(shared.brands)
          .filter(([slug, brand]) => brand.isAdult === true || adultOnly.has(slug))
          .map(([, brand]) => new URL(brand.url).hostname)
      )
      expect(adultHostnames.size).toBeGreaterThan(0)
      expect(brands.filter(brand => adultHostnames.has(brand.hostname))).toEqual([])
    }
  )
})

describe('parseNetworkBrands', () => {
  it('returns sorted brand entries with hostnames', () => {
    expect(
      parseNetworkBrands({
        brands: {
          zed: { name: 'Zed Brand', url: 'https://zed.example/path' },
          alpha: { name: 'Alpha Brand', url: 'https://alpha.example/' }
        }
      })
    ).toEqual([
      {
        hostname: 'alpha.example',
        name: 'Alpha Brand',
        slug: 'alpha',
        url: 'https://alpha.example/'
      },
      {
        hostname: 'zed.example',
        name: 'Zed Brand',
        slug: 'zed',
        url: 'https://zed.example/path'
      }
    ])
  })

  it('rejects duplicate normalized URLs', () => {
    expect(() =>
      parseNetworkBrands({
        brands: {
          first: { name: 'First', url: 'https://example.com/path?utm=1#top' },
          second: { name: 'Second', url: 'https://EXAMPLE.com/path/' }
        }
      })
    ).toThrow(
      'Duplicate network brand URL "https://EXAMPLE.com/path/" for "second" duplicates "first"'
    )
  })

  it('rejects invalid brand URLs', () => {
    expect(() =>
      parseNetworkBrands({ brands: { alpha: { name: 'Alpha', url: 'ftp://alpha.example' } } })
    ).toThrow('Invalid network brand URL for "alpha": ftp://alpha.example')
  })

  it('rejects missing names', () => {
    expect(() =>
      parseNetworkBrands({ brands: { alpha: { name: ' ', url: 'https://alpha.example' } } })
    ).toThrow('Network brand "alpha" must include a name')
  })
})
