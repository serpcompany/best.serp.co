import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveCheckedInSiteConfig } from '@serpdirectory/site-contract'
import { activeCheckedInSiteIds } from '@serpdirectory/site-contract/active-site-ids'
import { describe, expect, it } from 'vitest'

const siteIds = activeCheckedInSiteIds
const variants = ['light', 'dark'] as const

type R2FeaturedBadgeAsset = {
  contentType?: string
  height?: number
  key?: string
  siteId?: string
  source?: string
  variant?: string
  width?: number
}

function loadAssetMap(): R2FeaturedBadgeAsset[] {
  return JSON.parse(
    readFileSync(resolve('scripts/r2-featured-badge-assets.json'), 'utf-8')
  ) as R2FeaturedBadgeAsset[]
}

function loadApprovedAssetMap(): R2FeaturedBadgeAsset[] {
  return JSON.parse(
    readFileSync(resolve('scripts/featured-badge-approved-r2-assets.json'), 'utf-8')
  ) as R2FeaturedBadgeAsset[]
}

function loadUploadAssetMaps(): R2FeaturedBadgeAsset[] {
  return [...loadAssetMap(), ...loadApprovedAssetMap()]
}

function getExpectedAsset(siteId: (typeof siteIds)[number], variant: (typeof variants)[number]) {
  const config = resolveCheckedInSiteConfig(siteId)
  const key = config.badges?.featuredOn?.[variant] ?? `badge/featured-on-${siteId}-${variant}.svg`

  return {
    contentType: 'image/svg+xml',
    height: 50,
    key,
    siteId,
    source: `apps/${config.build.appPackageName}/public/${key}`,
    variant,
    width: 200
  }
}

describe('featured badge R2 asset map', () => {
  it('maps every featured badge to its R2 upload key', () => {
    const assetMap = loadAssetMap()
    const expectedAssets = siteIds.flatMap(siteId =>
      variants.map(variant => getExpectedAsset(siteId, variant))
    )

    expect(assetMap).toEqual(expectedAssets)
  })

  it('only points at generated local SVG sources that exist for QC before upload', () => {
    const missingSources = loadAssetMap().filter(asset => {
      return !asset.source || !existsSync(resolve(asset.source))
    })

    expect(missingSources).toEqual([])
  })

  it('has 200x50 local SVG sources for every badge referenced by site config', () => {
    const uploadAssetsByKey = new Map(
      loadUploadAssetMaps()
        .filter((asset): asset is R2FeaturedBadgeAsset & { key: string; source: string } =>
          Boolean(asset.key && asset.source)
        )
        .map(asset => [asset.key, asset])
    )
    const brokenConfiguredBadges = siteIds.flatMap(siteId => {
      const config = resolveCheckedInSiteConfig(siteId)
      const configuredBadges = config.badges?.featuredOn
      const keys = [configuredBadges?.light, configuredBadges?.dark]

      if (!configuredBadges?.light || !configuredBadges.dark) {
        return [`${siteId}: missing explicit featuredOn badge config`]
      }

      return keys.flatMap(key => {
        if (!key) {
          return []
        }

        const sourcePath =
          uploadAssetsByKey.get(key)?.source ??
          resolve('apps', config.build.appPackageName, 'public', key)
        const source = resolve(sourcePath)

        if (!existsSync(source)) {
          return [`${siteId}: missing ${key}`]
        }

        const svg = readFileSync(source, 'utf-8')
        return /<svg\b[^>]*width="200"[^>]*height="50"/.test(svg)
          ? []
          : [`${siteId}: not 200x50 ${key}`]
      })
    })

    expect(brokenConfiguredBadges).toEqual([])
  })

  it('includes every site-configured badge key in the R2 upload manifest', () => {
    const uploadedKeys = new Set(loadUploadAssetMaps().map(asset => asset.key))
    const missingConfiguredKeys = siteIds.flatMap(siteId => {
      const config = resolveCheckedInSiteConfig(siteId)
      const configuredBadges = config.badges?.featuredOn
      const keys = [configuredBadges?.light, configuredBadges?.dark].filter((key): key is string =>
        Boolean(key)
      )

      return keys.filter(key => !uploadedKeys.has(key)).map(key => `${siteId}: ${key}`)
    })

    expect(missingConfiguredKeys).toEqual([])
  })
})
