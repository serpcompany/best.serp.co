import { describe, expect, it } from 'vitest'
import { scanFeaturedBadge } from './badge-verifier'
import {
  submissionBadgeTargets,
  submissionBadgeVerificationTargets,
  tagChoices
} from './presentation'

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

describe('tag choices (#341)', () => {
  it('groups active tags under their hubs in the hubs’ order, leaving out unknown hubs', () => {
    expect(
      tagChoices(
        [
          { name: 'Writing', slug: 'writing' },
          { name: 'Design', slug: 'design' }
        ],
        [
          { category: 'design', name: 'Whiteboards', slug: 'whiteboards' },
          { category: 'writing', name: 'Note Taking', slug: 'note-taking' },
          { category: 'retired', name: 'Orphan', slug: 'orphan' }
        ]
      )
    ).toEqual([
      { category: 'writing', categoryName: 'Writing', label: 'Note Taking', slug: 'note-taking' },
      { category: 'design', categoryName: 'Design', label: 'Whiteboards', slug: 'whiteboards' }
    ])
  })
})
