import React, { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebsiteHero } from './website-hero'

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

  const props = node.props as { children?: ReactNode }

  return collectText(props.children)
}

const website = {
  description: 'Test listing description',
  media: {
    logo: 'https://cdn.example.com/logo.png'
  },
  name: 'Example Product',
  slug: 'example-product',
  website: 'https://serp.ly/123movies-downloader'
}

describe('WebsiteHero', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not render the listing website URL as hero text or an outbound anchor', () => {
    const hero = WebsiteHero({
      breadcrumbItems: [{ href: '/listing/example-product', name: 'Example Product' }],
      website,
      slots: {
        Badge: ({ children }) => <span>{children}</span>,
        Breadcrumb: () => <nav />,
        FavoriteButton: () => <button type="button">Favorite</button>,
        FaviconWithFallback: ({ name }) => <img alt={name} />
      }
    })

    expect(collectText(hero)).not.toContain('serp.ly/123movies-downloader')
    expect(collectHrefProps(hero)).not.toContain(website.website)
  })
})
