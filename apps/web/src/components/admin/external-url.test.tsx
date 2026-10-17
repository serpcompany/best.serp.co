import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalUrl } from './external-url'

describe("the review page's submitted URL (#492)", () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const markup = (url: string) => renderToStaticMarkup(<ExternalUrl url={url} />)

  it('links an https URL in a new tab, without referrer, opener or follow', () => {
    const html = markup('https://www.launchnests.com')
    expect(html).toMatch(/^<a [^>]*href="https:\/\/www\.launchnests\.com\/"/)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('font-mono')
    expect(html).toContain('>https://www.launchnests.com<')
  })

  it('links an http URL too', () => {
    expect(markup('http://example.com/path')).toContain('href="http://example.com/path"')
  })

  it.each([
    'javascript:alert(1)',
    'ftp://example.com/file',
    'www.launchnests.com',
    ' javascript:alert(1)'
  ])('keeps %j as plain text', value => {
    const html = markup(value)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).toMatch(/^<span class="font-mono/)
  })
})
