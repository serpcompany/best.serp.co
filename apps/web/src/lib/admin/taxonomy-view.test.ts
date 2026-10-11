import { describe, expect, it } from 'vitest'
import { groupSuggestions } from './taxonomy-view'

describe('category suggestions grouped (#406)', () => {
  it('groups names that differ only in case and spacing, most suggested first', () => {
    const row = (id: string, name: string, kind: 'revision' | 'submission' = 'submission') => ({
      categoryName: 'Tools',
      id,
      kind,
      listingName: `Listing ${id}`,
      name,
      note: null
    })
    const groups = groupSuggestions([
      row('a', 'Briefs'),
      row('b', 'Mind maps'),
      row('c', ' mind  Maps', 'revision')
    ])
    expect(groups.map(group => [group.name, group.count])).toEqual([
      ['Mind maps', 2],
      ['Briefs', 1]
    ])
    expect(groups[0]?.records.map(record => record.href)).toEqual([
      '/admin/submissions/b/',
      '/admin/revisions/c/'
    ])
  })
})
