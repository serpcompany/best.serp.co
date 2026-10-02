import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyLegalContentBranding,
  buildWebsiteLookupIndex,
  resolveWebsiteBySlug,
  resolveWebsiteBySlugFromIndex,
  toWebsiteBrowseCardMetadata,
  type WebsiteMetadata
} from './content-query'
import { siteConfig } from './site-config'

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

describe('applyLegalContentBranding', () => {
  it('never rewrites a domain that already ends in serp.co', () => {
    const branded = applyLegalContentBranding(
      'Visit {{domain}} or https://best.serp.co/about/. {{siteName}} runs it.',
      { domain: 'best.serp.co', siteName: 'SERP' }
    )

    expect(branded).toBe('Visit best.serp.co or https://best.serp.co/about/. SERP runs it.')
  })

  it('names contact addresses at the legal email domain, defaulting to the site domain', () => {
    expect(
      applyLegalContentBranding(
        'Email dmca[@]{{legalEmailDomain}}. Opt out at privacy[@]{{legalEmailDomain}}.',
        { domain: 'best.serp.co', legalEmailDomain: 'serp.co', siteName: 'SERP' }
      )
    ).toBe('Email dmca[@]serp.co. Opt out at privacy[@]serp.co.')
    expect(
      applyLegalContentBranding('dmca[@]{{legalEmailDomain}}', {
        domain: 'best.serp.co',
        siteName: 'SERP'
      })
    ).toBe('dmca[@]best.serp.co')
  })

  it('rebrands bare serp.co hostnames and SERP for another site, never an address', () => {
    expect(
      applyLegalContentBranding(
        'Write to privacy@serp.co or dmca[@]serp.co, or see https://serp.co/terms.',
        { domain: 'example.com', siteName: 'Example' }
      )
    ).toBe('Write to privacy@serp.co or dmca[@]serp.co, or see https://example.com/terms.')
    expect(
      applyLegalContentBranding('privacy@serp.co and dmca[@]serp.co', {
        domain: 'best.serp.co',
        siteName: 'SERP'
      })
    ).toBe('privacy@serp.co and dmca[@]serp.co')
    expect(
      applyLegalContentBranding('SERP operates {{siteName}}.', {
        domain: 'example.com',
        siteName: 'Best SERP'
      })
    ).toBe('Best SERP operates Best SERP.')
  })

  const legalDirectory = fileURLToPath(new URL('../../content/data/legal/', import.meta.url))
  const legalFiles = readdirSync(legalDirectory).filter(file => file.endsWith('.mdx'))
  // /legal/cookies/ still names placeholder example.com addresses, as best.serp.co does today
  // (serpcompany/best.serp.co#42, T-3). Nothing else may name an address off the legal domain.
  const placeholderAddresses: Record<string, string[]> = {
    'cookies.mdx': ['privacy@example.com', 'support@example.com']
  }

  it('covers every legal page', () => {
    expect(legalFiles.sort()).toEqual([
      'affiliate-disclosure.mdx',
      'cookies.mdx',
      'dmca.mdx',
      'privacy.mdx',
      'terms.mdx'
    ])
  })

  it.each(legalFiles)('renders %s with contact addresses at the legal email domain', file => {
    const branded = applyLegalContentBranding(readFileSync(join(legalDirectory, file), 'utf8'), {
      domain: siteConfig.domain,
      legalEmailDomain: siteConfig.legalEmailDomain,
      siteName: siteConfig.name
    })
    const addresses = [
      ...new Set(
        [...branded.matchAll(/\b([a-z0-9._%+-]+)(?:@|\[@\])([a-z0-9-]+(?:\.[a-z0-9-]+)+)/giu)].map(
          ([, local, domain]) => `${local}@${domain}`.toLowerCase()
        )
      )
    ]

    expect(branded).not.toMatch(/\{\{\w+\}\}/u)
    expect(branded).not.toContain('best.best.')
    expect(
      addresses.filter(address => !address.endsWith(`@${siteConfig.legalEmailDomain}`)).sort()
    ).toEqual(placeholderAddresses[file] ?? [])
    if (['dmca.mdx', 'privacy.mdx', 'terms.mdx'].includes(file))
      expect(addresses.length).toBeGreaterThan(0)
  })
})
