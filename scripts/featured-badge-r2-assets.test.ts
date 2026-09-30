import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { site } from '@serpdirectory/site-config'
import { describe, expect, it } from 'vitest'
import { project } from './project'

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

function getExpectedAsset(variant: (typeof variants)[number]) {
  const key = site.badges?.featuredOn?.[variant] ?? `badge/featured-on-${site.id}-${variant}.svg`

  return {
    contentType: 'image/svg+xml',
    height: 50,
    key,
    siteId: site.id,
    source: `${project.appDirectory}/public/${key}`,
    variant,
    width: 200
  }
}

describe('featured badge R2 asset map', () => {
  it('maps every featured badge to its R2 upload key', () => {
    expect(loadAssetMap()).toEqual(variants.map(getExpectedAsset))
  })

  it('only points at local SVG sources that exist for QC before upload', () => {
    const missingSources = loadAssetMap().filter(asset => {
      return !asset.source || !existsSync(resolve(asset.source))
    })

    expect(missingSources).toEqual([])
  })

  it('has 200x50 local SVG sources for every badge referenced by site config', () => {
    const configuredBadges = site.badges?.featuredOn
    expect(configuredBadges?.light, 'explicit light featuredOn badge').toBeTruthy()
    expect(configuredBadges?.dark, 'explicit dark featuredOn badge').toBeTruthy()

    const sourcesByKey = new Map(loadAssetMap().map(asset => [asset.key, asset.source]))
    const brokenConfiguredBadges = [configuredBadges?.light, configuredBadges?.dark].flatMap(
      key => {
        if (!key) {
          return []
        }

        const source = resolve(
          sourcesByKey.get(key) ?? resolve(project.appDirectory, 'public', key)
        )

        if (!existsSync(source)) {
          return [`missing ${key}`]
        }

        const svg = readFileSync(source, 'utf-8')
        return /<svg\b[^>]*width="200"[^>]*height="50"/.test(svg) ? [] : [`not 200x50 ${key}`]
      }
    )

    expect(brokenConfiguredBadges).toEqual([])
  })

  it('includes every site-configured badge key in the R2 upload manifest', () => {
    const uploadedKeys = new Set(loadAssetMap().map(asset => asset.key))
    const configuredBadges = site.badges?.featuredOn
    const missingConfiguredKeys = [configuredBadges?.light, configuredBadges?.dark]
      .filter((key): key is string => Boolean(key))
      .filter(key => !uploadedKeys.has(key))

    expect(missingConfiguredKeys).toEqual([])
  })
})
