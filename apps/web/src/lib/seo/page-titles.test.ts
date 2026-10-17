import { describe, expect, it } from 'vitest'
import {
  bestPageDescriptionLead,
  bestPageTitle,
  categoryDescriptionLead,
  categoryTitle,
  currentYear,
  DEFAULT_TOPIC_NOUN,
  listingDescriptionLead,
  listingTitle,
  TITLE_MAX_LENGTH,
  TITLE_SUFFIX,
  TOPIC_NOUN_OVERRIDES,
  tagDescriptionLead,
  tagTitle
} from './page-titles'

/** A name of exactly `length` characters. */
function nameOf(length: number): string {
  return 'Acmesoftwarestudio'.repeat(5).slice(0, length)
}

/** A name of exactly `length` characters ending in a plural noun for tools, so it takes no noun. */
function appsOf(length: number): string {
  return `${nameOf(length - 5)} Apps`
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
  it('writes {N}+ Best {Category} Software in {Year}', () => {
    expect(DEFAULT_TOPIC_NOUN).toBe('Software')
    expect(rendered(categoryTitle('Audio & Music', { count: 123, year }))).toBe(
      `123+ Best Audio & Music ${DEFAULT_TOPIC_NOUN} in 2026 | SERP Best`
    )
  })

  it('adds no second noun to a name that already names a kind of tool', () => {
    expect(categoryTitle('Developer Tools', { count: 266, year })).toBe(
      '266+ Best Developer Tools in 2026'
    )
    expect(categoryTitle('Chatbots & Agents', { count: 245, year })).toBe(
      '245+ Best Chatbots & Agents in 2026'
    )
    expect(categoryTitle('Careers & Hiring', { count: 40, year })).toBe(
      `40+ Best Careers & Hiring ${DEFAULT_TOPIC_NOUN} in 2026`
    )
    expect(categoryTitle('Data & Analytics', { count: 40, year })).toBe(
      `40+ Best Data & Analytics ${DEFAULT_TOPIC_NOUN} in 2026`
    )
  })

  it('adds the noun searches favour for an overridden name', () => {
    expect([...TOPIC_NOUN_OVERRIDES]).toEqual([
      ['Education', 'Apps'],
      ['Productivity', 'Apps'],
      ['SEO', 'Tools']
    ])
    expect(categoryTitle('Productivity', { count: 300, year })).toBe(
      '300+ Best Productivity Apps in 2026'
    )
    expect(categoryTitle('Education', { count: 40, year })).toBe('40+ Best Education Apps in 2026')
    expect(tagTitle('SEO', { count: 9, year })).toBe('9+ Best SEO Tools in 2026')
    expect(tagTitle('seo', { count: 9, year })).toBe('9+ Best SEO Tools in 2026')
    // The override is the whole name's: one that only ends in it takes the default.
    expect(tagTitle('Local SEO', { count: 9, year })).toBe('9+ Best Local SEO Software in 2026')
    expect(categoryTitle('Ecommerce', { count: 40, year })).toBe(
      '40+ Best Ecommerce Software in 2026'
    )
  })

  it('drops the year past the room it leaves, then the count past 8 characters more', () => {
    // "123+ Best ", " Software in 2026" and the suffix leave 21 characters for the name.
    const room = TITLE_MAX_LENGTH - `123+ Best  ${DEFAULT_TOPIC_NOUN} in 2026${TITLE_SUFFIX}`.length
    const at = (length: number) => categoryTitle(nameOf(length), { count: 123, year })
    expect(rendered(at(room))).toHaveLength(60)
    expect(at(room)).toBe(`123+ Best ${nameOf(room)} ${DEFAULT_TOPIC_NOUN} in 2026`)
    expect(at(room + 1)).toBe(`123+ Best ${nameOf(room + 1)} ${DEFAULT_TOPIC_NOUN}`)
    expect(at(room + 8)).toBe(`123+ Best ${nameOf(room + 8)} ${DEFAULT_TOPIC_NOUN}`)
    expect(at(room + 9)).toBe(`Best ${nameOf(room + 9)} ${DEFAULT_TOPIC_NOUN}`)
  })

  it('leads the meta description with every word of the full pattern', () => {
    expect(categoryDescriptionLead(nameOf(40), { count: 123, year })).toBe(
      `123+ best ${nameOf(40)} ${DEFAULT_TOPIC_NOUN} in 2026.`
    )
  })
})

describe('tagTitle (#521)', () => {
  it('writes {N}+ Best {Tag} in {Year} for a tag named by a plural noun for tools', () => {
    expect(rendered(tagTitle('AI Lyrics Generators', { count: 6, year }))).toBe(
      '6+ Best AI Lyrics Generators in 2026 | SERP Best'
    )
    expect(tagTitle('Review Management Software', { count: 6, year })).toBe(
      '6+ Best Review Management Software in 2026'
    )
  })

  it('adds the default noun to any other tag, by the category rule', () => {
    const topic = (name: string) => tagTitle(name, { count: 0, year }).replace(/ in 2026$/u, '')
    expect(topic('AI Lawyer')).toBe(`Best AI Lawyer ${DEFAULT_TOPIC_NOUN}`)
    expect(topic('Analytics')).toBe(`Best Analytics ${DEFAULT_TOPIC_NOUN}`)
    expect(topic('Payment Processing')).toBe(`Best Payment Processing ${DEFAULT_TOPIC_NOUN}`)
    expect(topic('AI News')).toBe(`Best AI News ${DEFAULT_TOPIC_NOUN}`)
    expect(topic('Headless CMS')).toBe(`Best Headless CMS ${DEFAULT_TOPIC_NOUN}`)
    expect(topic('Chatbots & Agents')).toBe('Best Chatbots & Agents')
    expect(topic('Web Proxies')).toBe('Best Web Proxies')
  })

  it('title-cases a name D1 has in lower case, keeping acronyms upper case', () => {
    expect(tagTitle('ai time tracking', { count: 6, year })).toBe(
      `6+ Best AI Time Tracking ${DEFAULT_TOPIC_NOUN} in 2026`
    )
    expect(tagTitle('ai productivity tools', { count: 6, year })).toBe(
      '6+ Best AI Productivity Tools in 2026'
    )
    expect(tagDescriptionLead('ai text to speech', { count: 6, year })).toBe(
      `6+ best AI Text to Speech ${DEFAULT_TOPIC_NOUN} in 2026.`
    )
    expect(tagTitle('Nextjs Templates', { count: 6, year })).toBe(
      '6+ Best Nextjs Templates in 2026'
    )
  })

  it('drops the year from 33 characters, then the count from 41, and never cuts the name', () => {
    const at = (length: number) => tagTitle(appsOf(length), { count: 6, year })
    expect(at(32)).toBe(`6+ Best ${appsOf(32)} in 2026`)
    expect(rendered(at(32))).toHaveLength(60)
    expect(at(33)).toBe(`6+ Best ${appsOf(33)}`)
    expect(rendered(at(40))).toHaveLength(60)
    expect(at(40)).toBe(`6+ Best ${appsOf(40)}`)
    expect(at(41)).toBe(`Best ${appsOf(41)}`)
    expect(rendered(at(43))).toHaveLength(60)
    expect(rendered(at(50))).toBe(`Best ${appsOf(50)} | SERP Best`)
  })

  it('has no count while it has no listing', () => {
    expect(tagTitle('AI Chatbots', { count: 0, year })).toBe('Best AI Chatbots in 2026')
    expect(tagDescriptionLead('AI Chatbots', { count: 0, year })).toBe('Best AI Chatbots in 2026.')
  })

  it('leads the meta description with every word of the full pattern', () => {
    expect(tagDescriptionLead(appsOf(50), { count: 6, year })).toBe(
      `6+ best ${appsOf(50)} in 2026.`
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
