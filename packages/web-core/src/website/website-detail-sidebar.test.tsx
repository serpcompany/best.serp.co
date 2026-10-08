import React, { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { siteConfig } from '../site-config'
import { outboundWebsiteRel, WebsiteDetailSidebar } from './website-detail-sidebar'

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
  }

  return [...(props.href ? [props.href] : []), ...collectHrefProps(props.children)]
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

describe('WebsiteDetailSidebar', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("adds the site's Dub partner ID to a serp.ly listing URL", () => {
    const sidebar = WebsiteDetailSidebar({
      website: {
        linkRel: 'follow',
        name: 'Example Product',
        slug: 'example-product',
        website: 'https://serp.ly/example-product'
      }
    })

    expect(collectHrefProps(sidebar)).toContain(
      `https://serp.ly/example-product?via=${siteConfig.dubPartnerId}`
    )
  })

  it('leaves non-SERP listing URLs unchanged', () => {
    const sidebar = WebsiteDetailSidebar({
      website: {
        linkRel: 'follow',
        name: 'Example Product',
        slug: 'example-product',
        website: 'https://vendor.example.com/pricing?plan=pro#buy'
      }
    })

    expect(collectHrefProps(sidebar)).toContain('https://vendor.example.com/pricing?plan=pro#buy')
  })

  it('renders the per-listing outbound rel, keeping followed links exactly as before', () => {
    const rels = (['follow', 'nofollow', 'sponsored'] as const).map(linkRel => {
      const sidebar = WebsiteDetailSidebar({
        website: {
          linkRel,
          name: 'Example Product',
          slug: 'example-product',
          website: 'https://vendor.example.com/'
        }
      })
      return collectStringProp(sidebar, 'rel')[0]
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
    const sidebar = WebsiteDetailSidebar({
      website: {
        linkRel: 'follow',
        name: 'LaunchBuzz',
        slug: 'launchbuzz.io',
        website: 'https://launchbuzz.io'
      }
    })

    expect(collectStringProp(sidebar, 'listingUrl')).toContain(
      'https://best.serp.co/products/launchbuzz.io/'
    )
    expect(collectRecordProp<Record<string, string>>(sidebar, 'badgeUrls')).toContainEqual({
      dark: 'https://best.serp.co/badge/featured-on-serp.co-dark.svg',
      light: 'https://best.serp.co/badge/featured-on-serp.co-light.svg'
    })
    expect(collectStringProp(sidebar, 'siteName')).toContain('SERP Best')
  })
})
