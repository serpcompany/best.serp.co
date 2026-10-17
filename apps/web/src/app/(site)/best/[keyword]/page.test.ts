import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BestPageItem, PublishedBestPage } from '@/db/contracts'
import { META_DESCRIPTION_MAX_LENGTH, META_DESCRIPTION_MIN_LENGTH } from '@/lib/seo/seo-helpers'

// One best page at a time, with its entries in rank order, as `getBestPageItems` returns them.
const catalog = vi.hoisted(() => ({ intro: '', names: [] as string[] }))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/catalog/repository', () => ({
  getBestPageBySlug: async (slug: string): Promise<PublishedBestPage> => ({
    category: 'writing',
    heading: 'Best AI writers',
    hub: 'writing',
    intro: catalog.intro,
    keyword: 'ai writer',
    lastModifiedAt: '2026-09-01T00:00:00.000Z',
    listSize: catalog.names.length,
    order: 0,
    poolSize: 40,
    slug,
    tag: null,
    title: 'Best AI Writers'
  }),
  getBestPageItems: async () => catalog.names.map(name => ({ name }) as BestPageItem)
}))

const WRITERS = ['Jasper', 'Copy.ai', 'Writesonic', 'Rytr', 'Anyword', 'Writer', 'Peppertype']

/** The best page's meta description for this intro and these entries. */
async function descriptionOf(intro: string, names: string[]): Promise<string> {
  Object.assign(catalog, { intro, names })
  const { generateMetadata } = await import('./page')
  const metadata = await generateMetadata({
    params: Promise.resolve({ keyword: 'ai-writer' }),
    searchParams: Promise.resolve({})
  })
  return String(metadata.description)
}

/** The best page's title, before the root layout's ` | SERP Best`. */
async function titleOf(names: string[]): Promise<string> {
  Object.assign(catalog, { intro: 'AI writers draft posts.', names })
  const { generateMetadata } = await import('./page')
  const metadata = await generateMetadata({
    params: Promise.resolve({ keyword: 'ai-writer' }),
    searchParams: Promise.resolve({})
  })
  return String(metadata.title)
}

// The year in titles and descriptions is the request's (#521).
beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-10-17T12:00:00.000Z'), toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})

describe('best page title (#521)', () => {
  it('is {N} Best {Keyword} in {Year}: the exact entry count and the D1 title', async () => {
    expect(await titleOf(WRITERS)).toBe('7 Best AI Writers in 2026')
  })
})

function expectSnippetLength(description: string) {
  expect(description.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_LENGTH)
  expect(description.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX_LENGTH)
}

describe('best page meta description (#426)', () => {
  it('pads a short intro with its top three entries, in rank order', async () => {
    const description = await descriptionOf(
      'AI writers draft blog posts, ads and emails from a short prompt. They write in any tone.',
      WRITERS
    )
    expect(description).toBe(
      '7 best AI Writers in 2026. AI writers draft blog posts, ads and emails from a short prompt. Includes Jasper, Copy.ai and Writesonic.'
    )
    expectSnippetLength(description)
  })

  it('names more entries while three leave it under the minimum', async () => {
    const description = await descriptionOf('AI SEO tools help pages rank in search.', WRITERS)
    expect(description).toBe(
      '7 best AI Writers in 2026. AI SEO tools help pages rank in search. Includes Jasper, Copy.ai, Writesonic and Rytr.'
    )
    expectSnippetLength(description)
  })

  it('names fewer entries when three would pass the maximum', async () => {
    const description = await descriptionOf(
      'Video downloaders save clips from the sites you watch, so they play offline later.',
      ['4K Video Downloader Plus', 'Allavsoft', 'Any Video Converter Ultimate']
    )
    expect(description).toBe(
      '3 best AI Writers in 2026. Video downloaders save clips from the sites you watch, so they play offline later. Includes 4K Video Downloader Plus and Allavsoft.'
    )
    expectSnippetLength(description)
  })

  it('leaves a description already at the minimum unchanged', async () => {
    const intro =
      'AI meeting assistants join your calls, record them and send a summary with action items.'
    const description = await descriptionOf(intro, WRITERS)
    expect(description).toBe(`7 best AI Writers in 2026. ${intro}`)
    expect(description.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_LENGTH)
  })
})
