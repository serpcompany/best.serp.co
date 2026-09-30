import { describe, expect, it } from 'vitest'
import { resolveDrBadgeConfig } from '../packages/web-core/src/layout/dr-badge.ts'
import { resolveFooterBadgeConfigs } from '../packages/web-core/src/layout/footer-badges.ts'

describe('resolveDrBadgeConfig', () => {
  it('returns the DR badge config for active directory domains', () => {
    expect(resolveDrBadgeConfig('serp.co')).toEqual({
      alt: 'Verified DR 78 for serp.co',
      href: 'https://dr.serp.co/sites/serp.co',
      src: 'https://dr.serp.co/badge/serp.co?style=serp-dr-v3'
    })
    expect(resolveDrBadgeConfig('serp.ai')).toEqual({
      alt: 'Verified DR 69 for serp.ai',
      href: 'https://dr.serp.co/sites/serp.ai',
      src: 'https://dr.serp.co/badge/serp.ai?style=serp-dr-v3'
    })
    expect(resolveDrBadgeConfig('serp.software')).toEqual({
      alt: 'Verified DR 27 for serp.software',
      href: 'https://dr.serp.co/sites/serp.software',
      src: 'https://dr.serp.co/badge/serp.software?style=serp-dr-v3'
    })
    expect(resolveDrBadgeConfig('serpdownloaders.com')).toEqual({
      alt: 'Verified DR 27 for serpdownloaders.com',
      href: 'https://dr.serp.co/sites/serpdownloaders.com',
      src: 'https://dr.serp.co/badge/serpdownloaders.com?style=serp-dr-v3'
    })
    expect(resolveDrBadgeConfig('browserextensions.io')).toEqual({
      alt: 'Verified DR 39 for browserextensions.io',
      href: 'https://dr.serp.co/sites/browserextensions.io',
      src: 'https://dr.serp.co/badge/browserextensions.io?style=serp-dr-v3'
    })
    expect(resolveDrBadgeConfig('pornvideodownloaders.com')).toEqual({
      alt: 'Verified DR 16 for pornvideodownloaders.com',
      href: 'https://dr.serp.co/sites/pornvideodownloaders.com',
      src: 'https://dr.serp.co/badge/pornvideodownloaders.com?style=serp-dr-v3'
    })
  })

  it('does not show a DR badge for non-directory/default domains', () => {
    expect(resolveDrBadgeConfig('example.com')).toBeUndefined()
  })
})

describe('resolveFooterBadgeConfigs', () => {
  it('returns the serp.co featured badge and DR badge for serp.ai', () => {
    expect(resolveFooterBadgeConfigs('serp.ai')).toEqual([
      {
        alt: 'Featured on serp.co',
        href: 'https://serp.co/products/serp.ai/reviews/',
        src: 'https://serp.co/badge/featured-on-serp.co-light.svg',
        title: 'Featured on serp.co'
      },
      {
        alt: 'Verified DR 69 for serp.ai',
        href: 'https://dr.serp.co/sites/serp.ai',
        src: 'https://dr.serp.co/badge/serp.ai?style=serp-dr-v3'
      }
    ])
  })

  it('does not return the serp.co featured badge for unrelated domains', () => {
    expect(resolveFooterBadgeConfigs('example.com')).toEqual([])
    expect(resolveFooterBadgeConfigs('serp.co')).toEqual([
      {
        alt: 'Verified DR 78 for serp.co',
        href: 'https://dr.serp.co/sites/serp.co',
        src: 'https://dr.serp.co/badge/serp.co?style=serp-dr-v3'
      }
    ])
  })
})
