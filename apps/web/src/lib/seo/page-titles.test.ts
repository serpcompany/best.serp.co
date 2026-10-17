import { describe, expect, it } from 'vitest'
import {
  bestPageDescriptionLead,
  bestPageTitle,
  categoryDescriptionLead,
  categoryTitle,
  currentYear,
  listingDescriptionLead,
  listingTitle,
  TITLE_MAX_LENGTH,
  TITLE_SUFFIX,
  tagDescriptionLead,
  tagTitle
} from './page-titles'

/** A name of exactly `length` characters. */
function nameOf(length: number): string {
  return 'Acmesoftwarestudio'.repeat(5).slice(0, length)
}

/** The `<title>` the root layout's template writes. */
function rendered(title: string): string {
  return `${title}${TITLE_SUFFIX}`
}

const year = 2026

describe('the site title suffix (#521)', () => {
  it('is SERP Best, measured into the 60 characters', () => {
    expect(TITLE_SUFFIX).toBe(' | SERP Best')
    expect(TITLE_MAX_LENGTH).toBe(60)
  })
})

describe('listingTitle (#521)', () => {
  it('writes Review, Rating & Alternatives after a short name', () => {
    expect(rendered(listingTitle('Zenbu Japanese'))).toBe(
      'Zenbu Japanese Review, Rating & Alternatives | SERP Best'
    )
  })

  it('keeps the full pattern up to 18 characters, exactly 60 with the suffix', () => {
    expect(rendered(listingTitle(nameOf(18)))).toBe(
      `${nameOf(18)} Review, Rating & Alternatives | SERP Best`
    )
    expect(rendered(listingTitle(nameOf(18)))).toHaveLength(60)
  })

  it('steps down to Review & Alternatives from 19 to 26 characters', () => {
    expect(listingTitle(nameOf(19))).toBe(`${nameOf(19)} Review & Alternatives`)
    expect(rendered(listingTitle(nameOf(26)))).toBe(
      `${nameOf(26)} Review & Alternatives | SERP Best`
    )
    expect(rendered(listingTitle(nameOf(26)))).toHaveLength(60)
  })

  it('steps down to Alternatives from 27 to 35 characters', () => {
    expect(listingTitle(nameOf(27))).toBe(`${nameOf(27)} Alternatives`)
    expect(rendered(listingTitle(nameOf(35)))).toBe(`${nameOf(35)} Alternatives | SERP Best`)
    expect(rendered(listingTitle(nameOf(35)))).toHaveLength(60)
  })

  it('is the bare name from 36 characters, never cut and still suffixed', () => {
    expect(listingTitle(nameOf(36))).toBe(nameOf(36))
    const long = 'HiFiveStar - Reviews and Reputation Management Software'
    expect(rendered(listingTitle(long))).toBe(`${long} | SERP Best`)
  })

  it('counts characters, not UTF-16 units', () => {
    const sushi = `${nameOf(17)}🍣`
    expect(listingTitle(sushi)).toBe(`${sushi} Review, Rating & Alternatives`)
  })

  it('fits 60 characters whenever a pattern can, and always starts with the whole name', () => {
    for (let length = 1; length <= 80; length += 1) {
      const title = listingTitle(nameOf(length))
      expect(title.startsWith(nameOf(length))).toBe(true)
      if (length <= 35) expect(rendered(title).length).toBeLessThanOrEqual(60)
    }
  })

  it('leads the meta description with every word of the full pattern', () => {
    expect(listingDescriptionLead(nameOf(40))).toBe(`${nameOf(40)} review, rating & alternatives.`)
  })
})

describe('categoryTitle (#521)', () => {
  it('writes {N}+ Best {Category} Tools in {Year}', () => {
    expect(rendered(categoryTitle('Audio & Music', { count: 123, year }))).toBe(
      '123+ Best Audio & Music Tools in 2026 | SERP Best'
    )
  })

  it('adds no second noun to a name that already names a kind of tool', () => {
    expect(categoryTitle('Developer Tools', { count: 266, year })).toBe(
      '266+ Best Developer Tools in 2026'
    )
    expect(categoryTitle('Video Downloaders', { count: 55, year })).toBe(
      '55+ Best Video Downloaders in 2026'
    )
    expect(categoryTitle('Chatbots & Agents', { count: 245, year })).toBe(
      '245+ Best Chatbots & Agents in 2026'
    )
    expect(categoryTitle('Careers & Hiring', { count: 40, year })).toBe(
      '40+ Best Careers & Hiring Tools in 2026'
    )
  })

  it('drops the year from 25 characters, then the count from 33', () => {
    // "123+ Best " and " Tools in 2026" with the suffix leave 24 characters for the name.
    expect(rendered(categoryTitle(nameOf(24), { count: 123, year }))).toHaveLength(60)
    expect(categoryTitle(nameOf(24), { count: 123, year })).toBe(
      `123+ Best ${nameOf(24)} Tools in 2026`
    )
    expect(categoryTitle(nameOf(25), { count: 123, year })).toBe(`123+ Best ${nameOf(25)} Tools`)
    expect(categoryTitle(nameOf(32), { count: 123, year })).toBe(`123+ Best ${nameOf(32)} Tools`)
    expect(categoryTitle(nameOf(33), { count: 123, year })).toBe(`Best ${nameOf(33)} Tools`)
  })

  it('leads the meta description with every word of the full pattern', () => {
    expect(categoryDescriptionLead(nameOf(40), { count: 123, year })).toBe(
      `123+ best ${nameOf(40)} Tools in 2026.`
    )
  })
})

describe('tagTitle (#521)', () => {
  it('writes {N}+ Best {Label} in {Year}', () => {
    expect(rendered(tagTitle('AI Lyrics Generators', { count: 6, year }))).toBe(
      '6+ Best AI Lyrics Generators in 2026 | SERP Best'
    )
  })

  it('drops the year from 33 characters, then the count from 41, and never cuts the name', () => {
    const at = (length: number) => tagTitle(nameOf(length), { count: 6, year })
    expect(at(32)).toBe(`6+ Best ${nameOf(32)} in 2026`)
    expect(rendered(at(32))).toHaveLength(60)
    expect(at(33)).toBe(`6+ Best ${nameOf(33)}`)
    expect(rendered(at(40))).toHaveLength(60)
    expect(at(40)).toBe(`6+ Best ${nameOf(40)}`)
    expect(at(41)).toBe(`Best ${nameOf(41)}`)
    expect(rendered(at(43))).toHaveLength(60)
    expect(rendered(at(50))).toBe(`Best ${nameOf(50)} | SERP Best`)
  })

  it('has no count while it has no listing', () => {
    expect(tagTitle('AI Chatbots', { count: 0, year })).toBe('Best AI Chatbots in 2026')
    expect(tagDescriptionLead('AI Chatbots', { count: 0, year })).toBe('Best AI Chatbots in 2026.')
  })

  it('leads the meta description with every word of the full pattern', () => {
    expect(tagDescriptionLead(nameOf(50), { count: 6, year })).toBe(
      `6+ best ${nameOf(50)} in 2026.`
    )
  })
})

describe('bestPageTitle (#521)', () => {
  it('writes {N} Best {Keyword} in {Year} with the exact count, from the D1 title', () => {
    expect(rendered(bestPageTitle('Best AI Music Generators', { count: 12, year }))).toBe(
      '12 Best AI Music Generators in 2026 | SERP Best'
    )
    expect(bestPageTitle('AI Music Generators', { count: 12, year })).toBe(
      '12 Best AI Music Generators in 2026'
    )
  })

  it('drops the year from 33 characters, then the count from 41', () => {
    const at = (length: number) => bestPageTitle(`Best ${nameOf(length)}`, { count: 12, year })
    expect(at(32)).toBe(`12 Best ${nameOf(32)} in 2026`)
    expect(rendered(at(32))).toHaveLength(60)
    expect(at(33)).toBe(`12 Best ${nameOf(33)}`)
    expect(rendered(at(40))).toHaveLength(60)
    expect(at(41)).toBe(`Best ${nameOf(41)}`)
  })

  it('leads the meta description with every word of the full pattern', () => {
    expect(bestPageDescriptionLead('Best AI Music Generators', { count: 12, year })).toBe(
      '12 best AI Music Generators in 2026.'
    )
  })
})

describe('currentYear', () => {
  it('is the UTC year of the request', () => {
    expect(currentYear(new Date('2026-12-31T23:59:59.999Z'))).toBe(2026)
    expect(currentYear(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027)
  })
})
