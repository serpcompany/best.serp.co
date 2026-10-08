import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINK_LINT_PATTERNS,
  findForbiddenLinks,
  isProtectedListingSurface
} from './forbidden-links'

const BANNED = 'https://help.serp.co/en/'

describe('forbidden listing links', () => {
  it('finds Help Center links with their line and column', () => {
    const page = ['export default function Page() {', `  return <a href="${BANNED}">Help</a>`, '}']
    expect(findForbiddenLinks(page.join('\n'))).toEqual([{ column: 19, line: 2, url: BANNED }])
    expect(findForbiddenLinks(`<url><loc>${BANNED}articles/example</loc></url>`)).toHaveLength(1)
    expect(findForbiddenLinks('Support: https://help.serp.co/en\r\nnext')).toEqual([
      { column: 10, line: 1, url: 'https://help.serp.co/en' }
    ])
  })

  it('finds a quoted or punctuated link with no trailing slash', () => {
    expect(findForbiddenLinks('<a href="https://help.serp.co/en">Help</a>')).toHaveLength(1)
    expect(findForbiddenLinks("const help = 'https://help.serp.co/en'")).toHaveLength(1)
    expect(findForbiddenLinks('(see https://help.serp.co/en), then')).toHaveLength(1)
  })

  it('allows other Help Center paths and hosts', () => {
    expect(
      findForbiddenLinks(
        'https://help.serp.co/fr/ https://serp.co/en/ https://help.serp.co/english https://help.serp.co/en-us/'
      )
    ).toEqual([])
  })

  it('checks app sources, content, public assets and built pages, not tests outside apps/', () => {
    for (const path of [
      'apps/web/src/lib/catalog/repository.ts',
      'apps/web/src/app/products/[slug]/page.tsx',
      'apps/web/src/lib/site/site.ts',
      'apps/web/content/legal/terms-conditions.mdx',
      'apps/web/public/support.txt',
      'apps/web/.open-next/assets/products/example-downloader/index.html',
      'apps/web/.open-next/assets/sitemap.xml'
    ]) {
      expect(isProtectedListingSurface(path), path).toBe(true)
    }
    expect(isProtectedListingSurface('scripts/forbidden-links.test.ts')).toBe(false)
    expect(isProtectedListingSurface('apps/web/public/logo.png')).toBe(false)
  })

  it.each(DEFAULT_LINK_LINT_PATTERNS)('default pattern %s matches files (#172)', pattern => {
    // A pattern a move left behind would check nothing and pass.
    expect(globSync(pattern, { exclude: ['**/node_modules/**'] }).length).toBeGreaterThan(0)
  })
})
