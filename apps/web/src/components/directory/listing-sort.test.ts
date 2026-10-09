import { describe, expect, it } from 'vitest'
import { formatListingCount } from '../../lib/site/site-copy'
import { sortListings } from './listing-sort'

const listings = [
  { name: 'Beta', publishedAt: '2026-01-02' },
  { name: 'alpha', publishedAt: '2026-03-01' },
  { name: 'Gamma', publishedAt: '2026-02-01T12:00:00Z' }
]

describe('sortListings', () => {
  it('sorts by name, ignoring case', () => {
    expect(sortListings(listings, 'name').map(listing => listing.name)).toEqual([
      'alpha',
      'Beta',
      'Gamma'
    ])
  })

  it('sorts newest first', () => {
    expect(sortListings(listings, 'latest').map(listing => listing.name)).toEqual([
      'alpha',
      'Gamma',
      'Beta'
    ])
  })

  it('leaves the input in place', () => {
    sortListings(listings, 'latest')
    expect(listings.map(listing => listing.name)).toEqual(['Beta', 'alpha', 'Gamma'])
  })
})

describe('formatListingCount', () => {
  it('uses the singular for one listing (#269 review)', () => {
    expect(formatListingCount(1)).toBe('1 product')
    expect(formatListingCount(0)).toBe('0 products')
    expect(formatListingCount(48)).toBe('48 products')
  })
})
