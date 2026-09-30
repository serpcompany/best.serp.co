import { describe, expect, it } from 'vitest'
import {
  buildWebsiteLookupIndex,
  resolveWebsiteBySlug,
  resolveWebsiteBySlugFromIndex,
  toWebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from './content-query'

const websites: WebsiteMetadata[] = [
  {
    slug: 'newer-listing',
    name: 'Newer Listing',
    description: 'Newer listing.',
    website: 'https://newer.example.com',
    category: 'alpha',
    categories: ['alpha'],
    publishedAt: '2026-01-03',
    featured: true,
    isUnofficial: true,
    media: {
      logo: '/logos/newer.png',
      images: ['/images/newer-screenshot.png'],
      video: 'https://newer.example.com/demo.mp4'
    },
    content: 'Newer listing body.',
    resourceLinks: [
      {
        label: 'Newer Docs',
        url: 'https://newer.example.com/docs'
      }
    ]
  },
  {
    slug: 'target-listing',
    name: 'Target Listing',
    description: 'Target listing.',
    website: 'https://target.example.com',
    category: 'alpha',
    categories: ['alpha', 'beta'],
    publishedAt: '2026-01-02',
    media: {
      logo: '/logos/target.png',
      images: ['/images/target-screenshot.png']
    },
    content: 'Target listing body.',
    resourceLinks: [
      {
        label: 'Target Docs',
        url: 'https://target.example.com/docs'
      }
    ]
  },
  {
    slug: 'older-listing',
    name: 'Older Listing',
    description: 'Older listing.',
    website: 'https://older.example.com',
    category: 'beta',
    categories: ['beta'],
    publishedAt: '2026-01-01',
    media: {
      logo: '/logos/older.png',
      images: ['/images/older-screenshot.png']
    },
    content: 'Older listing body.',
    resourceLinks: [
      {
        label: 'Older Docs',
        url: 'https://older.example.com/docs'
      }
    ]
  },
  {
    slug: 'unrelated-listing',
    name: 'Unrelated Listing',
    description: 'Unrelated listing.',
    website: 'https://unrelated.example.com',
    category: 'gamma',
    categories: ['gamma'],
    publishedAt: '2025-12-31'
  }
]

describe('website lookup index', () => {
  it('resolves details with previous and next entries from the provided ordering', () => {
    const detail = resolveWebsiteBySlugFromIndex(
      buildWebsiteLookupIndex(websites),
      'target-listing'
    )

    expect(detail?.slug).toBe('target-listing')
    expect(detail?.content).toBe('Target listing body.')
    expect(detail?.categories).toEqual(['alpha', 'beta'])
    expect(detail?.media?.images).toEqual(['/images/target-screenshot.png'])
    expect(detail?.resourceLinks).toEqual([
      {
        label: 'Target Docs',
        url: 'https://target.example.com/docs'
      }
    ])
    expect(detail?.previousWebsite?.slug).toBe('newer-listing')
    expect(detail?.nextWebsite?.slug).toBe('older-listing')
  })

  it('keeps the related listing algorithm ordered by shared categories then name', () => {
    const detail = resolveWebsiteBySlugFromIndex(
      buildWebsiteLookupIndex(websites),
      'target-listing'
    )

    expect(detail?.relatedWebsites.map(website => website.slug)).toEqual([
      'newer-listing',
      'older-listing'
    ])
  })

  it('returns slim related card and navigation payloads', () => {
    const detail = resolveWebsiteBySlugFromIndex(
      buildWebsiteLookupIndex(websites),
      'target-listing'
    )

    expect(detail?.relatedWebsites).toEqual([
      {
        slug: 'newer-listing',
        name: 'Newer Listing',
        description: 'Newer listing.',
        website: 'https://newer.example.com',
        isUnofficial: true,
        media: {
          logo: '/logos/newer.png'
        }
      },
      {
        slug: 'older-listing',
        name: 'Older Listing',
        description: 'Older listing.',
        website: 'https://older.example.com',
        media: {
          logo: '/logos/older.png'
        }
      }
    ])
    expect(detail?.previousWebsite).toEqual({
      slug: 'newer-listing',
      name: 'Newer Listing',
      website: 'https://newer.example.com',
      media: {
        logo: '/logos/newer.png'
      }
    })
    expect(detail?.nextWebsite).toEqual({
      slug: 'older-listing',
      name: 'Older Listing',
      website: 'https://older.example.com',
      media: {
        logo: '/logos/older.png'
      }
    })

    for (const relatedWebsite of detail?.relatedWebsites || []) {
      expect(relatedWebsite).not.toHaveProperty('content')
      expect(relatedWebsite).not.toHaveProperty('resourceLinks')
      expect(relatedWebsite).not.toHaveProperty('categories')
      expect(relatedWebsite.media).not.toHaveProperty('images')
      expect(relatedWebsite.media).not.toHaveProperty('video')
    }

    for (const navWebsite of [detail?.previousWebsite, detail?.nextWebsite]) {
      expect(navWebsite).not.toHaveProperty('content')
      expect(navWebsite).not.toHaveProperty('resourceLinks')
      expect(navWebsite).not.toHaveProperty('categories')
      expect(navWebsite).not.toHaveProperty('description')
      expect(navWebsite?.media).not.toHaveProperty('images')
      expect(navWebsite?.media).not.toHaveProperty('video')
    }
  })

  it('returns slim browse card payloads for client list surfaces', () => {
    const browseCard = toWebsiteBrowseCardMetadata(websites[0])

    expect(browseCard).toEqual({
      slug: 'newer-listing',
      name: 'Newer Listing',
      description: 'Newer listing.',
      website: 'https://newer.example.com',
      category: 'alpha',
      categories: ['alpha'],
      publishedAt: '2026-01-03',
      featured: true,
      isUnofficial: true,
      media: {
        logo: '/logos/newer.png'
      }
    })
    expect(browseCard).not.toHaveProperty('content')
    expect(browseCard).not.toHaveProperty('resourceLinks')
    expect(browseCard.media).not.toHaveProperty('images')
    expect(browseCard.media).not.toHaveProperty('video')
  })

  it('preserves first-match slug semantics for duplicate slugs', () => {
    const firstDuplicate = {
      ...websites[0],
      slug: 'duplicate-listing',
      name: 'First Duplicate'
    }
    const secondDuplicate = {
      ...websites[2],
      slug: 'duplicate-listing',
      name: 'Second Duplicate'
    }
    const duplicateWebsites = [firstDuplicate, websites[1], secondDuplicate]
    const index = buildWebsiteLookupIndex(duplicateWebsites)

    expect(index.websiteBySlug.get('duplicate-listing')).toBe(firstDuplicate)
    expect(index.websiteIndexBySlug.get('duplicate-listing')).toBe(0)
    expect(resolveWebsiteBySlugFromIndex(index, 'duplicate-listing')?.name).toBe('First Duplicate')
  })

  it('keeps the existing array-scan resolver output compatible', () => {
    expect(resolveWebsiteBySlug(websites, 'target-listing')).toEqual(
      resolveWebsiteBySlugFromIndex(buildWebsiteLookupIndex(websites), 'target-listing')
    )
  })
})
