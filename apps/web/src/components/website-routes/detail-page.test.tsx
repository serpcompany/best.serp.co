import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { WebsiteDetailMetadata } from '../../lib/directory/content-query'
import { listingContentTree } from '../../lib/markdown/listing-content-tree'
import { WebsiteContentSection } from '../website/website-content-section'
import { WebsiteDetailRoutePage } from './detail-page'

function findElement(node: ReactNode, type: unknown): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  if (node.type === type) return node as { props: Record<string, unknown> }
  const props = node.props as Record<string, ReactNode>
  for (const value of Object.values(props)) {
    const found = findElement(value, type)
    if (found) return found
  }
  return null
}

describe('the listing detail page (#334)', () => {
  it('hands the body section the cached tree the catalog adapter attached', () => {
    const contentTree = listingContentTree('Cached body', false)
    const project: WebsiteDetailMetadata = {
      category: 'fixture-tools',
      content: 'Cached body',
      contentTree,
      description: 'A fixture listing.',
      name: 'Fixture',
      nextWebsite: null,
      previousWebsite: null,
      publishedAt: '2026-07-04T00:00:00.000Z',
      relatedWebsites: [],
      slug: 'fixture.test',
      website: 'https://fixture.test/'
    }
    const section = findElement(WebsiteDetailRoutePage({ project }), WebsiteContentSection)
    expect(section?.props.contentTree).toBe(contentTree)
    expect(section?.props.website).toBe(project)
  })
})
