import React, { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { siteConfig } from '../../lib/site/site-config'
import {
  outboundWebsiteRel,
  WebsiteDetailActions,
  WebsiteDetailAside,
  websiteDetailMeta
} from './website-detail-header'

function collectHrefProps(node: ReactNode): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(child => collectHrefProps(child))
  }

  if (!isValidElement(node)) {
    return []
  }

  const props = node.props as {
    children?: ReactNode
    href?: string
    render?: ReactNode
  }

  // A Base UI part linked through `render={<Link href=… />}` counts as its link.
  return [
    ...(props.href ? [props.href] : []),
    ...collectHrefProps(props.render),
    ...collectHrefProps(props.children)
  ]
}

function collectStringProp(node: ReactNode, propName: string): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(child => collectStringProp(child, propName))
  }

  if (!isValidElement(node)) {
    return []
  }

  const props = node.props as {
    children?: ReactNode
    [key: string]: unknown
  }
  const propValue = props[propName]

  return [
    ...(typeof propValue === 'string' ? [propValue] : []),
    ...collectStringProp(props.children, propName)
  ]
}

function collectRecordProp<T extends Record<string, unknown>>(
  node: ReactNode,
  propName: string
): T[] {
  if (Array.isArray(node)) {
    return node.flatMap(child => collectRecordProp<T>(child, propName))
  }

  if (!isValidElement(node)) {
    return []
  }

  const props = node.props as {
    children?: ReactNode
    [key: string]: unknown
  }
  const propValue = props[propName]

  return [
    ...(propValue && typeof propValue === 'object' && !Array.isArray(propValue)
      ? [propValue as T]
      : []),
    ...collectRecordProp<T>(props.children, propName)
  ]
}

function collectText(node: ReactNode): string {
  if (Array.isArray(node)) {
    return node.map(child => collectText(child)).join('')
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (!isValidElement(node)) {
    return ''
  }
  return collectText((node.props as { children?: ReactNode }).children)
}

describe('the product page header', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("adds the site's Dub partner ID to a serp.ly listing URL", () => {
    const actions = WebsiteDetailActions({
      website: {
        linkRel: 'follow',
        slug: 'example-product',
        website: 'https://serp.ly/example-product'
      }
    })

    expect(collectHrefProps(actions)).toContain(
      `https://serp.ly/example-product?via=${siteConfig.dubPartnerId}`
    )
  })

  it('leaves non-SERP listing URLs unchanged', () => {
    const actions = WebsiteDetailActions({
      website: {
        linkRel: 'follow',
        slug: 'example-product',
        website: 'https://vendor.example.com/pricing?plan=pro#buy'
      }
    })

    expect(collectHrefProps(actions)).toContain('https://vendor.example.com/pricing?plan=pro#buy')
  })

  it('renders the per-listing outbound rel, keeping followed links exactly as before', () => {
    const rels = (['follow', 'nofollow', 'sponsored'] as const).map(linkRel => {
      const actions = WebsiteDetailActions({
        website: {
          linkRel,
          slug: 'example-product',
          website: 'https://vendor.example.com/'
        }
      })
      return collectStringProp(actions, 'rel')[0]
    })
    expect(rels).toEqual([
      'noopener noreferrer',
      'nofollow noopener noreferrer',
      'sponsored noopener noreferrer'
    ])
    // An unexpected value fails safe to nofollow.
    expect(outboundWebsiteRel('ugc' as 'follow')).toBe('nofollow noopener noreferrer')
  })

  it('passes suffix-aware listing URLs and badge names into copied badge embeds', () => {
    const aside = WebsiteDetailAside({ website: { slug: 'launchbuzz.io' } })

    expect(collectStringProp(aside, 'listingUrl')).toContain(
      'https://best.serp.co/products/launchbuzz.io/'
    )
    expect(collectRecordProp<Record<string, string>>(aside, 'badgeUrls')).toContainEqual({
      dark: 'https://best.serp.co/badge/featured-on-serp.co-dark.svg',
      light: 'https://best.serp.co/badge/featured-on-serp.co-light.svg'
    })
    expect(collectStringProp(aside, 'siteName')).toContain('SERP Best')
  })

  it('offers the claim only on a listing without an owner', () => {
    const claim = <button type="button">Claim this listing</button>
    const unowned = WebsiteDetailAside({ claim, website: { slug: 'example-product' } })
    const owned = WebsiteDetailAside({
      claim,
      website: { slug: 'example-product', verifiedOwner: true }
    })

    expect(collectText(unowned)).toContain('Claim this listing')
    expect(collectText(owned)).not.toContain('Claim this listing')
  })

  it('shows the badges, the hub, other categories and tags as links, and nothing for none', () => {
    const meta = websiteDetailMeta({
      categories: [
        { name: 'Video Downloaders', slug: 'video-downloaders' },
        { name: 'Browser Extensions', slug: 'browser-extensions' }
      ],
      isUnofficial: true,
      tags: [{ name: 'Vimeo', slug: 'vimeo' }],
      verifiedOwner: true
    })

    expect(collectText(meta)).toContain('Unofficial')
    // Names from D1, not the slug-casing helper (#347).
    expect(collectText(meta)).toContain('Video DownloadersBrowser ExtensionsVimeo')
    expect(collectHrefProps(meta)).toEqual([
      '/products/categories/video-downloaders/',
      '/products/categories/browser-extensions/',
      '/products/tags/vimeo/'
    ])
    expect(websiteDetailMeta({})).toBeUndefined()
    expect(websiteDetailMeta({ categories: [], tags: [] })).toBeUndefined()
  })
})
