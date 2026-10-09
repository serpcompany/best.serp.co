import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRoute } from '@/lib/routing/routes'
import { LegalStaticPage } from './legal-page'

function breadcrumbItems(markup: string): unknown[] {
  const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(markup)?.[1]
  const schema = JSON.parse(json ?? '{}') as { itemListElement?: Array<{ item: unknown }> }
  return (schema.itemListElement ?? []).map(entry => entry.item)
}

describe('legal page (#276)', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const markup = () =>
    renderToStaticMarkup(
      <LegalStaticPage content={'# Privacy Policy\n\nPolicy text.'} path={getRoute('privacy')} />
    )

  it('writes its breadcrumb, Home to Legal to the page, as canonical JSON-LD', () => {
    expect(breadcrumbItems(markup())).toEqual([
      'https://best.serp.co',
      'https://best.serp.co/legal/',
      'https://best.serp.co/legal/privacy-policy/'
    ])
  })

  it('has one h1, the legal nav marking the page, and the policy in the docs article', () => {
    const html = markup()
    expect(html.match(/<h1[\s>]/gu)).toHaveLength(1)
    expect(html).toMatch(/<h1[^>]*>Privacy Policy<\/h1>/u)
    expect(html).toMatch(/<nav aria-label="Legal pages">/u)
    expect(html).toMatch(/aria-current="page"[^>]*>Privacy Policy</u)
    expect(html).toMatch(/<article class="prose-docs">\s*<p>Policy text\.<\/p><\/article>/u)
  })
})
