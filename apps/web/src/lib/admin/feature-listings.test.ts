import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { FEATURE_LISTING_IDS, isFeatureListing } from './feature-listings'

/** #405: the admin never pins a feature listing, the same ones #349's mapping passed over. */
describe('feature listings', () => {
  it('are exactly the reviewed mapping’s featureListings', () => {
    const mapping = parse(
      readFileSync(resolve(__dirname, '../../../../../d1/hygiene/2026-10-10-taxonomy.yaml'), 'utf8')
    ) as { featureListings: Array<{ id: string }> }
    expect([...FEATURE_LISTING_IDS].sort()).toEqual(
      mapping.featureListings.map(entry => entry.id).sort()
    )
    expect(isFeatureListing('lst_31a93dfdd1a9daea71399d95')).toBe(true)
    expect(isFeatureListing('lst_not_a_feature')).toBe(false)
  })
})
