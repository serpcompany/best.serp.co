import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getNetworkBrands,
  getNetworkBrandsForGroup,
  parseNetworkBrandGroup,
  parseNetworkBrands
} from '../packages/web-core/src/network-brands.ts'

const serpBrandsJsonPath = '/Users/devin/dev/repos/serp/docs/websites/pages/brands.json'
const localBrandsJsonPath = resolve(process.cwd(), 'packages/web-core/src/data/network-brands.json')

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

  it('returns sorted brand group entries with hostnames', () => {
    expect(
      parseNetworkBrandGroup(
        {
          brandGroups: {
            example: ['zed', 'alpha']
          },
          brands: {
            zed: { name: 'Zed Brand', url: 'https://zed.example/path' },
            alpha: { name: 'Alpha Brand', url: 'https://alpha.example/' }
          }
        },
        'example'
      )
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
      parseNetworkBrands({
        brands: {
          alpha: { name: 'Alpha', url: 'ftp://alpha.example' }
        }
      })
    ).toThrow('Invalid network brand URL for "alpha": ftp://alpha.example')
  })

  it('rejects missing names', () => {
    expect(() =>
      parseNetworkBrands({
        brands: {
          alpha: { name: ' ', url: 'https://alpha.example' }
        }
      })
    ).toThrow('Network brand "alpha" must include a name')
  })

  it('returns committed network brands data', () => {
    const brands = getNetworkBrands()

    expect(brands.length).toBeGreaterThan(0)
    expect(brands[0]).toEqual(
      expect.objectContaining({
        hostname: expect.any(String),
        name: expect.any(String),
        slug: expect.any(String),
        url: expect.stringMatching(/^https?:\/\//)
      })
    )
  })

  it.runIf(existsSync(serpBrandsJsonPath))(
    'keeps committed network brands data in parity with the serp repo source JSON',
    () => {
      const sourceBrands = JSON.parse(readFileSync(serpBrandsJsonPath, 'utf8'))
      const localBrands = JSON.parse(readFileSync(localBrandsJsonPath, 'utf8'))

      expect(localBrands).toEqual(sourceBrands)
    }
  )

  it('returns the committed adult-only brand group from the shared source data', () => {
    const brands = getNetworkBrandsForGroup('adultsOnly')

    expect(brands).toHaveLength(62)
    expect(brands.map(brand => brand.name)).toEqual(
      brands.map(brand => brand.name).toSorted((first, second) => first.localeCompare(second))
    )
    expect(brands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'SERP XXX',
          url: 'https://serp.xxx'
        }),
        expect.objectContaining({
          name: 'OnlyFans Video Downloader',
          url: 'https://onlyfansvideodownloader.com'
        }),
        expect.objectContaining({
          name: 'JustForFans Downloader',
          url: 'https://justforfansdownloader.com'
        }),
        expect.objectContaining({
          name: 'Porn Video Downloaders',
          url: 'https://pornvideodownloaders.com'
        }),
        expect.objectContaining({
          name: 'Porno Downloaders',
          url: 'https://pornodownloaders.com'
        }),
        expect.objectContaining({
          name: 'xHamster Video Downloader',
          url: 'https://xhamstervideodownloader.com'
        }),
        expect.objectContaining({
          name: 'Erome Video Downloader',
          url: 'https://eromevideodownloader.com'
        })
      ])
    )
  })

  it('rejects brand groups that reference missing brand entries', () => {
    expect(() =>
      parseNetworkBrandGroup(
        {
          brandGroups: {
            example: ['missing-brand']
          },
          brands: {}
        },
        'example'
      )
    ).toThrow('Network brand group "example" references missing brand "missing-brand"')
  })
})
