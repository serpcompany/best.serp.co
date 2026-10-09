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
const publicDirectory = resolve(project.appDirectory, 'public')

/** Sibling checkouts in the owner's layout. The comparisons with them skip when one is missing. */
const reposRoot = process.env.SERP_REPOS_ROOT ?? resolve(homedir(), 'dev/repos')
const devinschumacherCom = resolve(reposRoot, 'devinschumacher.com')
const serpCo = resolve(reposRoot, 'serp.co')
const serpBrandData = resolve(reposRoot, 'serp/workers/brands-page/data')

const sourceCopy = JSON.parse(readFileSync(sourceCopyPath, 'utf8')) as RawNetworkBrandsData
const sourceBrands = Object.values(sourceCopy.brands ?? {})
const brands = getNetworkBrands()

describe('/brands/ data source (#193)', () => {
  it('reads an unedited copy of the list devinschumacher.com/brands/ renders', () => {
    expect(NETWORK_BRANDS_SOURCE).toEqual({
      page: 'https://devinschumacher.com/brands/',
      path: 'lib/data/network-brands.json',
      repository: 'devinschumacher/devinschumacher.com'
    })
    expect(brands).toEqual(selectNetworkBrands(sourceCopy))
  })

  it.runIf(existsSync(resolve(devinschumacherCom, NETWORK_BRANDS_SOURCE.path)))(
    'keeps the copy identical to the devinschumacher.com checkout',
    () => {
      expect(
        readFileSync(sourceCopyPath, 'utf8'),
        `Copy ${NETWORK_BRANDS_SOURCE.repository}'s ${NETWORK_BRANDS_SOURCE.path} to ${sourceCopyPath}`
      ).toBe(readFileSync(resolve(devinschumacherCom, NETWORK_BRANDS_SOURCE.path), 'utf8'))
    }
  )

  it("lists the source's brands without this site, plus devinschumacher.com", () => {
    const listed = sourceBrands.filter(
      brand => !SELF_HOSTNAMES.has(new URL(brand.url ?? '').hostname)
    )
    expect(listed.length).toBe(sourceBrands.length - 1)
    expect(brands).toHaveLength(listed.length + 1)
    for (const brand of [...listed, ...Object.values(ADDED_NETWORK_BRANDS)]) {
      expect(brands).toContainEqual(
        expect.objectContaining({
          description: brand.description,
          imageSrc: brand.logo,
          name: brand.name,
          url: brand.url
        })
      )
    }
    expect(brands.map(brand => brand.hostname)).toEqual([
      'boxingundefeated.com',
      'browserextensions.io',
      'devinschumacher.com',
      'keybumps.app',
      'serp.co',
      'serp.ai',
      'apps.serp.co',
      'dr.serp.co',
      'extensions.serp.co',
      'games.serp.co',
      'serplists.com',
      'tools.serp.co',
      'zenbujapanese.com'
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

  it.runIf(existsSync(resolve(serpBrandData, 'brands.json')))(
    'lists no brand the shared brand data marks as adult',
    () => {
      const shared = JSON.parse(readFileSync(resolve(serpBrandData, 'brands.json'), 'utf8')) as {
        brands: Record<string, { isAdult?: boolean; url: string }>
      }
      const { brandSets } = JSON.parse(
        readFileSync(resolve(serpBrandData, 'brand-sets.json'), 'utf8')
      ) as { brandSets: Record<string, string[]> }
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

  it('lists every brand with a description and a logo file this site serves', () => {
    for (const brand of brands) {
      expect(brand.description, brand.slug).not.toBe('')
      expect(brand.imageSrc, brand.slug).toMatch(/^\/logos\/[\w-]+\.png$/u)
      expect(existsSync(resolve(publicDirectory, `.${brand.imageSrc}`)), brand.imageSrc).toBe(true)
    }
  })

  it.runIf(existsSync(resolve(devinschumacherCom, 'public/logos')))(
    "serves devinschumacher.com's logo files unedited",
    () => {
      for (const brand of brands) {
        const added = brand.slug in ADDED_NETWORK_BRANDS
        // devinschumacher.com's own logo is serp.co's: devinschumacher.com has none in /logos/.
        const origin = added
          ? resolve(serpCo, 'apps/web/public')
          : resolve(devinschumacherCom, 'public')
        if (!existsSync(origin)) continue
        expect(
          readFileSync(resolve(publicDirectory, `.${brand.imageSrc}`)).equals(
            readFileSync(resolve(origin, `.${brand.imageSrc}`))
          ),
          brand.imageSrc
        ).toBe(true)
      }
    }
  )
})

describe('parseNetworkBrands', () => {
  const brand = (name: string, url: string) => ({
    description: `${name} description`,
    logo: '/logos/example.png',
    name,
    url
  })

  it('returns sorted brand entries with hostnames', () => {
    expect(
      parseNetworkBrands({
        brands: {
          zed: brand('Zed Brand', 'https://zed.example/path'),
          alpha: brand('Alpha Brand', 'https://alpha.example/')
        }
      })
    ).toEqual([
      {
        description: 'Alpha Brand description',
        hostname: 'alpha.example',
        imageSrc: '/logos/example.png',
        name: 'Alpha Brand',
        slug: 'alpha',
        url: 'https://alpha.example/'
      },
      {
        description: 'Zed Brand description',
        hostname: 'zed.example',
        imageSrc: '/logos/example.png',
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
          first: brand('First', 'https://example.com/path?utm=1#top'),
          second: brand('Second', 'https://EXAMPLE.com/path/')
        }
      })
    ).toThrow(
      'Duplicate network brand URL "https://EXAMPLE.com/path/" for "second" duplicates "first"'
    )
  })

  it('rejects invalid brand URLs', () => {
    expect(() =>
      parseNetworkBrands({ brands: { alpha: brand('Alpha', 'ftp://alpha.example') } })
    ).toThrow('Invalid network brand URL for "alpha": ftp://alpha.example')
  })

  it('rejects missing names and descriptions', () => {
    expect(() =>
      parseNetworkBrands({ brands: { alpha: brand(' ', 'https://alpha.example') } })
    ).toThrow('Network brand "alpha" must include a name')
    expect(() =>
      parseNetworkBrands({
        brands: { alpha: { ...brand('Alpha', 'https://alpha.example'), description: '' } }
      })
    ).toThrow('Network brand "alpha" must include a description')
  })

  it('rejects a logo that is not a root-relative path', () => {
    for (const logo of [undefined, 'logos/alpha.png', '//cdn.example/alpha.png']) {
      expect(() =>
        parseNetworkBrands({
          brands: { alpha: { ...brand('Alpha', 'https://alpha.example'), logo } }
        })
      ).toThrow('Network brand "alpha" must name its logo as a root-relative path')
    }
  })
})
