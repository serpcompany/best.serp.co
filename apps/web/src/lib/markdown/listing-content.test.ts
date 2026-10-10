import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isListingContentTree,
  LISTING_CONTENT_FORMAT,
  listingContentTree,
  stripDuplicateLinksSection
} from './listing-content'
import { KITCHEN_SINK_BODY, REVIEW_BODY } from './listing-content-test-support'

describe('listing content trees (#334)', () => {
  it('captures the tree react-markdown renders, without source positions', () => {
    const tree = listingContentTree(REVIEW_BODY, true)
    expect(tree.type).toBe('root')
    expect(JSON.stringify(tree)).not.toContain('"position"')
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree)
    // react-markdown's own handling is already applied: no raw nodes, no unsafe URLs.
    const json = JSON.stringify(listingContentTree(KITCHEN_SINK_BODY, false))
    expect(json).not.toContain('"type":"raw"')
    expect(json).not.toContain('javascript:')
  })

  it('pins the format: a change in the tree a body parses to needs a new LISTING_CONTENT_FORMAT', () => {
    // Trees cached under one format are read back by later deploys, until the epoch changes. If
    // a dependency upgrade or a pipeline change alters this hash, bump LISTING_CONTENT_FORMAT so
    // the old trees are not served, then update both values here.
    const hash = createHash('sha256')
      .update(
        JSON.stringify([true, false].map(links => listingContentTree(KITCHEN_SINK_BODY, links)))
      )
      .digest('hex')
    expect({ format: LISTING_CONTENT_FORMAT, hash }).toEqual({
      format: 'gfm-1',
      hash: '0dfd685898426651fa346be7341d4ecf658a31d5b46ab05592ab2944c2b23b81'
    })
  })

  it('leaves out a trailing "Links" section only when the page lists resource links', () => {
    expect(stripDuplicateLinksSection('Intro\n## Links\n- [a](https://a.test/)', true)).toBe(
      'Intro'
    )
    expect(stripDuplicateLinksSection('Intro\n## Links\n- [a](https://a.test/)', false)).toBe(
      'Intro\n## Links\n- [a](https://a.test/)'
    )
  })

  it('accepts only a root from the data cache', () => {
    expect(isListingContentTree(listingContentTree('Hi', false))).toBe(true)
    for (const value of [null, 'tree', { type: 'root' }, { children: [], type: 'element' }]) {
      expect(isListingContentTree(value)).toBe(false)
    }
  })
})
