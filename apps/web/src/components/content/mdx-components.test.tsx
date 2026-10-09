import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components } from './mdx-components'

const markdown = [
  '## Heading',
  '',
  'A paragraph with a [link](https://example.com/), `code`, and ![an image](/image.png).',
  '',
  '- one',
  '- two',
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
    expect(markup).toContain('<td class=')
    expect(markup).not.toContain(' node=')
  })
})
