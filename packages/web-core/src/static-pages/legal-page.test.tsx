import { Breadcrumb } from '@serpdirectory/design-system/breadcrumb'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegalStaticPage } from './legal-page'

function breadcrumbItems(markup: string): unknown[] {
  const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(markup)?.[1]
  const schema = JSON.parse(json ?? '{}') as { itemListElement?: Array<{ item: unknown }> }
  return (schema.itemListElement ?? []).map(entry => entry.item)
}

describe('legal page breadcrumb', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes canonical URLs in its JSON-LD for a slashless page path', () => {
    const markup = renderToStaticMarkup(
      <LegalStaticPage
        content="Policy text."
        mdxComponents={{}}
        path="/legal/privacy"
        slots={{ Breadcrumb }}
        title="Privacy Policy"
      />
    )
    expect(breadcrumbItems(markup)).toEqual([
      'https://best.serp.co',
      'https://best.serp.co/legal/privacy/'
    ])
  })
})
