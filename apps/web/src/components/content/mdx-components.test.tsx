import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { siteConfig } from '../../lib/site/site-config'
import { components } from './mdx-components'

const markdown = [
  '## Heading',
  '',
  '### Third',
  '',
  '#### Fourth',
  '',
  '##### Fifth',
  '',
  '###### Sixth',
  '',
  'A paragraph with a [link](https://example.com/), `code`, and ![an image](/image.png).',
  '',
  '- one',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '> A quote.',
  '',
  '---',
  '',
  '| Name | Purpose |',
  '| --- | --- |',
  '| session | Keeps you signed in |',
  '',
  '```',
  'pre',
  '```'
].join('\n')

describe('Markdown components (#289)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps react-markdown's node prop out of the DOM", () => {
    const markup = renderToStaticMarkup(
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
    )
    for (const tag of ['h2', 'h3', 'h4', 'h5', 'h6', 'ol', 'ul', 'blockquote', 'hr', 'img', 'td']) {
      expect(markup).toContain(`<${tag} `)
    }
    expect(markup).not.toContain(' node=')
  })

  it('tags a serp.ly link in body text with the Dub partner ID, and leaves others (#169)', () => {
    const markup = renderToStaticMarkup(
      <ReactMarkdown components={components}>
        {'[Start here](https://serp.ly/start) or [elsewhere](https://example.com/).'}
      </ReactMarkdown>
    )
    const via = encodeURIComponent(siteConfig.dubPartnerId ?? '')
    expect(via).not.toBe('')
    expect(markup).toContain(`href="https://serp.ly/start?via=${via}"`)
    expect(markup).toContain('href="https://example.com/"')
  })
})
