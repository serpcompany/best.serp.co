import React, { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { siteConfig } from '../site-config'
import { WebsiteDetailSidebar } from './website-detail-sidebar'

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

  it('decorates SERP listing URLs with the current site via domain', () => {
    const sidebar = WebsiteDetailSidebar({
      website: {
        name: 'Example Product',
        slug: 'example-product',
        website: 'https://serp.ly/example-product'
      }
    })

    expect(collectHrefProps(sidebar)).toContain(
      `https://serp.ly/example-product?via=${siteConfig.domain}`
    )
  })

  it('leaves non-SERP listing URLs unchanged', () => {
    const sidebar = WebsiteDetailSidebar({
      website: {
        name: 'Example Product',
        slug: 'example-product',
        website: 'https://vendor.example.com/pricing?plan=pro#buy'
      }
    })

    expect(collectHrefProps(sidebar)).toContain('https://vendor.example.com/pricing?plan=pro#buy')
  })

  it('passes suffix-aware listing URLs into copied badge embeds for suffix-based sites', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_ID', 'serp.co')
    vi.stubEnv('SITE_ID', 'serp.co')
    vi.resetModules()

    const { WebsiteDetailSidebar: SerpCoWebsiteDetailSidebar } = await import(
      './website-detail-sidebar'
    )
    const sidebar = SerpCoWebsiteDetailSidebar({
      website: {
        name: 'LaunchBuzz',
        slug: 'launchbuzz.io',
        website: 'https://launchbuzz.io'
      }
    })

    expect(collectStringProp(sidebar, 'listingUrl')).toContain(
      'https://serp.co/products/launchbuzz.io/reviews/'
    )
    expect(collectRecordProp<Record<string, string>>(sidebar, 'badgeUrls')).toContainEqual({
      dark: 'https://serp.co/badge/featured-on-serp.co-dark.svg',
      light: 'https://serp.co/badge/featured-on-serp.co-light.svg'
    })
  })

  it('passes the configured badge display name into copied badge embeds', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_ID', 'pornvideodownloaders.com')
    vi.stubEnv('SITE_ID', 'pornvideodownloaders.com')
    vi.resetModules()

    const { WebsiteDetailSidebar: PvdWebsiteDetailSidebar } = await import(
      './website-detail-sidebar'
    )
    const sidebar = PvdWebsiteDetailSidebar({
      website: {
        name: 'LaunchBuzz',
        slug: 'launchbuzz.io',
        website: 'https://launchbuzz.io'
      }
    })

    expect(collectStringProp(sidebar, 'siteName')).toContain('PV Downloaders')
  })
})
