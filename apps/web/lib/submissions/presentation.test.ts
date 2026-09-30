import { describe, expect, it } from 'vitest'
import { scanFeaturedBadge } from './badge-verifier'
import { submissionBadgeTargets, submissionBadgeVerificationTargets } from './presentation'

describe('submission badge targets', () => {
  it('points the featured badge at the canonical best.serp.co listing URL', () => {
    expect(submissionBadgeTargets('example.com')).toEqual({
      badgeUrls: [
        'https://best.serp.co/badge/featured-on-serp.co-light.svg',
        'https://best.serp.co/badge/featured-on-serp.co-dark.svg'
      ],
      listingUrl: 'https://best.serp.co/products/example.com/'
    })
  })

  it('accepts the embed markup produced from the same targets', () => {
    const targets = submissionBadgeTargets('example.com')
    for (const badgeUrl of targets.badgeUrls) {
      expect(
        scanFeaturedBadge(`<a href="${targets.listingUrl}"><img src="${badgeUrl}"></a>`, targets)
      ).toEqual({ ok: true })
    }
  })

  it('still verifies badges embedded with the legacy /reviews/ listing URL', () => {
    const targets = submissionBadgeVerificationTargets('example.com')
    expect(targets.legacyListingUrls).toEqual([
      'https://best.serp.co/products/example.com/reviews/'
    ])
    expect(
      scanFeaturedBadge(
        `<a href="https://best.serp.co/products/example.com/reviews/"><img src="${targets.badgeUrls[0]}"></a>`,
        targets
      )
    ).toEqual({ ok: true })
  })
})
