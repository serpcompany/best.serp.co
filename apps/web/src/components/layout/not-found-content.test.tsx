import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRoute } from '@/lib/routing/routes'
import { NotFoundContent } from './not-found-content'

describe('the 404 page (#279)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the page, offers the homepage, and lists the popular pages but not the homepage', () => {
    const markup = renderToStaticMarkup(<NotFoundContent />)
    // next/link drops the trailing slash outside the app (no `trailingSlash` config here).
    const path = (href: string) => href.replace(/(.)\/$/u, '$1')
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/gu)].map(([, href]) => path(href))

    expect(markup).toMatch(/<h1 [^>]*>Page not found<\/h1>/u)
    expect(hrefs).toEqual(
      [getRoute('home'), getRoute('category.index'), getRoute('brands')].map(path)
    )
  })
})
