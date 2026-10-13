import { describe, expect, it, vi } from 'vitest'
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
      'AI writers draft blog posts, ads and emails from a short prompt. 7 products. Includes Jasper, Copy.ai and Writesonic.'
    )
    expectSnippetLength(description)
  })

  it('names more entries while three leave it under the minimum', async () => {
    const description = await descriptionOf('AI SEO tools help pages rank in search.', WRITERS)
    expect(description).toBe(
      'AI SEO tools help pages rank in search. 7 products. Includes Jasper, Copy.ai, Writesonic, Rytr, Anyword and Writer.'
    )
    expectSnippetLength(description)
  })

  it('names fewer entries when three would pass the maximum', async () => {
    const description = await descriptionOf(
      'Video downloaders save clips from the sites you watch, so they play offline later.',
      ['4K Video Downloader Plus', 'Allavsoft', 'Any Video Converter Ultimate']
    )
    expect(description).toBe(
      'Video downloaders save clips from the sites you watch, so they play offline later. 3 products. Includes 4K Video Downloader Plus and Allavsoft.'
    )
    expectSnippetLength(description)
  })

  it('leaves a description already at the minimum unchanged', async () => {
    const intro =
      'AI meeting assistants join your calls, record them and send a summary with action items to everyone after.'
    const description = await descriptionOf(intro, WRITERS)
    expect(description).toBe(`${intro} 7 products.`)
    expect(description.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_LENGTH)
  })
})
