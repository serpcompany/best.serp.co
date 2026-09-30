import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSplitSitemaps } from './sitemap-files.ts'

const tempDirs: string[] = []
const DEFAULT_LASTMOD = '2026-06-19T08:00:00.000Z'

function makeTempArtifactDir(): string {
  mkdirSync(resolve(process.cwd(), 'tmp'), { recursive: true })
  const dir = mkdtempSync(resolve(process.cwd(), 'tmp/sitemap-files-'))
  tempDirs.push(dir)
  return dir
}

function writeFile(path: string, contents = 'test'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

afterEach(() => {
  tempDirs.splice(0).forEach(dir => {
    rmSync(dir, { force: true, recursive: true })
  })
})

describe('writeSplitSitemaps', () => {
  it('writes sitemap index files and grouped page files for the static artifact', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'about/index.html'))
    writeFile(resolve(artifactDir, 'docs/index.html'))
    writeFile(resolve(artifactDir, 'products/index.html'))
    writeFile(resolve(artifactDir, 'products/example-tool/index.html'))
    writeFile(resolve(artifactDir, 'products/launchbuzz.io/index.html'))
    writeFile(resolve(artifactDir, 'categories/developer-tools/index.html'))
    writeFile(resolve(artifactDir, 'categories/featured/index.html'))
    writeFile(resolve(artifactDir, 'cookies/index.html'))
    writeFile(resolve(artifactDir, 'news/index.html'))
    writeFile(resolve(artifactDir, 'privacy/index.html'))
    writeFile(resolve(artifactDir, 'terms/index.html'))
    writeFile(resolve(artifactDir, 'legal/privacy/index.html'))
    writeFile(resolve(artifactDir, 'search/index.html'))
    writeFile(resolve(artifactDir, 'submit/index.html'))
    writeFile(resolve(artifactDir, '404.html'))

    writeSplitSitemaps(artifactDir, {
      baseUrl: 'https://example.com',
      defaultLastmod: DEFAULT_LASTMOD,
      listingBasePath: 'products'
    })

    expect(existsSync(resolve(artifactDir, 'sitemap-index.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'sitemap.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'pages-sitemap.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'listings-sitemap.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'taxonomies-sitemap.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'docs-sitemap.xml'))).toBe(true)

    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/pages-sitemap.xml</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      `<lastmod>${DEFAULT_LASTMOD}</lastmod>`
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/listings-sitemap.xml</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/taxonomies-sitemap.xml</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/docs-sitemap.xml</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap.xml'), 'utf8')).toBe(
      readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')
    )

    const pagesSitemap = readFileSync(resolve(artifactDir, 'pages-sitemap.xml'), 'utf8')
    expect(pagesSitemap).toContain('<loc>https://example.com/</loc>')
    expect(pagesSitemap).toContain(`<lastmod>${DEFAULT_LASTMOD}</lastmod>`)
    expect(pagesSitemap).toContain('<loc>https://example.com/about/</loc>')
    expect(pagesSitemap).toContain('<loc>https://example.com/legal/privacy/</loc>')
    expect(pagesSitemap).not.toContain('https://example.com/cookies')
    expect(pagesSitemap).not.toContain('https://example.com/news')
    expect(pagesSitemap).not.toContain('https://example.com/privacy')
    expect(pagesSitemap).not.toContain('https://example.com/terms')
    expect(pagesSitemap).not.toContain('https://example.com/search')
    expect(pagesSitemap).not.toContain('https://example.com/submit')

    const listingSitemap = readFileSync(resolve(artifactDir, 'listings-sitemap.xml'), 'utf8')
    expect(listingSitemap).toContain('<loc>https://example.com/products/example-tool/</loc>')
    expect(listingSitemap).toContain('<loc>https://example.com/products/launchbuzz.io/</loc>')
    expect(listingSitemap).toContain(`<lastmod>${DEFAULT_LASTMOD}</lastmod>`)

    const taxonomiesSitemap = readFileSync(resolve(artifactDir, 'taxonomies-sitemap.xml'), 'utf8')
    expect(taxonomiesSitemap).toContain('<loc>https://example.com/products/</loc>')
    expect(taxonomiesSitemap).toContain(
      '<loc>https://example.com/categories/developer-tools/</loc>'
    )
    expect(taxonomiesSitemap).toContain('<loc>https://example.com/categories/featured/</loc>')

    const docsSitemap = readFileSync(resolve(artifactDir, 'docs-sitemap.xml'), 'utf8')
    expect(docsSitemap).toContain('<loc>https://example.com/docs/</loc>')
  })

  it('skips optional sitemap families when there are no matching public routes', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'products/index.html'))
    writeFile(resolve(artifactDir, 'products/example-tool/index.html'))

    writeSplitSitemaps(artifactDir, {
      baseUrl: 'https://example.com',
      defaultLastmod: DEFAULT_LASTMOD,
      listingBasePath: 'products'
    })

    expect(existsSync(resolve(artifactDir, 'taxonomies-sitemap.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'docs-sitemap.xml'))).toBe(false)
    expect(existsSync(resolve(artifactDir, 'posts-sitemap.xml'))).toBe(false)
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).not.toContain(
      'docs-sitemap.xml'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).not.toContain(
      'posts-sitemap.xml'
    )
  })

  it('splits large sitemap groups into multiple files using the configured page size', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'about/index.html'))
    writeFile(resolve(artifactDir, 'docs/index.html'))
    writeFile(resolve(artifactDir, 'legal/privacy/index.html'))

    writeSplitSitemaps(artifactDir, {
      baseUrl: 'https://example.com',
      defaultLastmod: DEFAULT_LASTMOD,
      listingBasePath: 'products',
      pageSize: 2
    })

    expect(existsSync(resolve(artifactDir, 'pages-sitemap-1.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'pages-sitemap-2.xml'))).toBe(true)
    expect(existsSync(resolve(artifactDir, 'pages-sitemap.xml'))).toBe(false)
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/pages-sitemap-1.xml</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/pages-sitemap-2.xml</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'pages-sitemap-1.xml'), 'utf8')).toContain(
      `<lastmod>${DEFAULT_LASTMOD}</lastmod>`
    )
  })

  it('excludes configured legacy root listing aliases from sitemap output', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'products/index.html'))
    writeFile(resolve(artifactDir, 'products/example-tool/index.html'))
    writeFile(resolve(artifactDir, 'example-tool/index.html'))

    writeSplitSitemaps(artifactDir, {
      baseUrl: 'https://example.com',
      defaultLastmod: DEFAULT_LASTMOD,
      excludedPaths: ['/example-tool'],
      listingBasePath: 'products'
    })

    const pagesSitemap = readFileSync(resolve(artifactDir, 'pages-sitemap.xml'), 'utf8')
    const listingsSitemap = readFileSync(resolve(artifactDir, 'listings-sitemap.xml'), 'utf8')

    expect(pagesSitemap).not.toContain('<loc>https://example.com/example-tool</loc>')
    expect(listingsSitemap).not.toContain('<loc>https://example.com/example-tool</loc>')
    expect(listingsSitemap).toContain('<loc>https://example.com/products/example-tool/</loc>')
  })

  it('allows live static routes to be explicitly excluded from sitemap output', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'legal/privacy/index.html'))
    writeFile(resolve(artifactDir, 'submit/index.html'))

    writeSplitSitemaps(artifactDir, {
      baseUrl: 'https://example.com',
      defaultLastmod: DEFAULT_LASTMOD,
      excludedPaths: ['/legal/privacy', '/submit'],
      listingBasePath: 'products',
      staticPagePaths: ['/', '/legal/privacy', '/submit']
    })

    const pagesSitemap = readFileSync(resolve(artifactDir, 'pages-sitemap.xml'), 'utf8')

    expect(pagesSitemap).toContain('<loc>https://example.com/</loc>')
    expect(pagesSitemap).not.toContain('https://example.com/legal/privacy')
    expect(pagesSitemap).not.toContain('https://example.com/submit')
  })

  it('skips redirect and error shell route indexes from sitemap output', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'products/index.html'), 'NEXT_REDIRECT')
    writeFile(resolve(artifactDir, 'products/example-tool/index.html'))
    writeFile(resolve(artifactDir, 'submit/verify/index.html'), '__next_error__')

    writeSplitSitemaps(artifactDir, {
      baseUrl: 'https://example.com',
      defaultLastmod: DEFAULT_LASTMOD,
      listingBasePath: 'products'
    })

    const listingsSitemap = readFileSync(resolve(artifactDir, 'listings-sitemap.xml'), 'utf8')
    expect(listingsSitemap).toContain('<loc>https://example.com/products/example-tool/</loc>')

    const pagesSitemap = readFileSync(resolve(artifactDir, 'pages-sitemap.xml'), 'utf8')
    expect(pagesSitemap).not.toContain('https://example.com/submit/verify/')

    const sitemapIndex = readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')
    expect(sitemapIndex).not.toContain('taxonomies-sitemap.xml')
    expect(readFileSync(resolve(artifactDir, 'listings-sitemap.xml'), 'utf8')).not.toContain(
      '<loc>https://example.com/products/</loc>'
    )
    expect(readFileSync(resolve(artifactDir, 'listings-sitemap.xml'), 'utf8')).not.toContain(
      'https://example.com/submit/verify/'
    )
  })

  it('can emit configured sitemap paths and public URL shapes', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))
    writeFile(resolve(artifactDir, 'contact/index.html'))
    writeFile(resolve(artifactDir, 'posts/index.html'))
    writeFile(resolve(artifactDir, 'products/index.html'))
    writeFile(resolve(artifactDir, 'products/example-tool/index.html'))
    writeFile(resolve(artifactDir, 'products/example-tool/reviews/index.html'))
    writeFile(resolve(artifactDir, 'products/best/video-downloaders/index.html'))
    writeFile(resolve(artifactDir, 'products/best/legacy-category/index.html'))
    writeFile(resolve(artifactDir, 'categories/developer-tools/index.html'))
    writeFile(resolve(artifactDir, 'categories/featured/index.html'))
    writeFile(resolve(artifactDir, 'submit/index.html'))
    writeFile(resolve(artifactDir, 'pages-sitemap.xml'), '<urlset></urlset>')
    writeFile(resolve(artifactDir, 'listings-sitemap.xml'), '<urlset></urlset>')
    writeFile(resolve(artifactDir, 'taxonomies-sitemap.xml'), '<urlset></urlset>')
    writeFile(resolve(artifactDir, 'docs-sitemap.xml'), '<urlset></urlset>')
    writeFile(resolve(artifactDir, 'posts-sitemap.xml'), '<urlset></urlset>')

    writeSplitSitemaps(artifactDir, {
      additionalPathsByGroup: {
        taxonomies: ['/products/best/legacy-category']
      },
      baseUrl: 'https://example.com',
      categoryBasePath: 'products/best',
      defaultLastmod: DEFAULT_LASTMOD,
      excludedPaths: ['/products/best/featured'],
      listingBasePath: 'products',
      listingDetailSuffix: 'reviews',
      lastmodByPath: {
        '/products/example-tool/reviews': '2026-05-16'
      },
      sitemapPathByGroup: {
        listings: '/sitemaps/directory/1.xml',
        pages: '/sitemaps/pages/1.xml',
        posts: '/sitemaps/blog/1.xml',
        taxonomies: '/sitemaps/categories/1.xml'
      },
      staticPagePaths: ['/', '/contact', '/posts', '/submit']
    })

    expect(readFileSync(resolve(artifactDir, 'sitemap-index.xml'), 'utf8')).toContain(
      '<loc>https://example.com/sitemaps/directory/1.xml</loc>'
    )

    const listingsSitemap = readFileSync(resolve(artifactDir, 'sitemaps/directory/1.xml'), 'utf8')
    expect(listingsSitemap).toContain(
      '<loc>https://example.com/products/example-tool/reviews/</loc>'
    )
    expect(listingsSitemap).toContain('<lastmod>2026-05-16</lastmod>')
    expect(listingsSitemap).not.toContain('<loc>https://example.com/products/example-tool</loc>')
    expect(listingsSitemap).not.toContain(
      '<loc>https://example.com/products/best/video-downloaders/reviews/</loc>'
    )

    const taxonomiesSitemap = readFileSync(
      resolve(artifactDir, 'sitemaps/categories/1.xml'),
      'utf8'
    )
    expect(taxonomiesSitemap).toContain(
      '<loc>https://example.com/products/best/developer-tools/</loc>'
    )
    expect(taxonomiesSitemap).toContain(
      '<loc>https://example.com/products/best/legacy-category/</loc>'
    )
    expect(taxonomiesSitemap).toContain(
      '<loc>https://example.com/products/best/video-downloaders/</loc>'
    )
    expect(taxonomiesSitemap).not.toContain(
      '<loc>https://example.com/categories/developer-tools</loc>'
    )
    expect(taxonomiesSitemap).not.toContain('<loc>https://example.com/products/best/featured</loc>')

    const pagesSitemap = readFileSync(resolve(artifactDir, 'sitemaps/pages/1.xml'), 'utf8')
    expect(pagesSitemap).toContain('<loc>https://example.com/</loc>')
    expect(pagesSitemap).toContain(`<lastmod>${DEFAULT_LASTMOD}</lastmod>`)
    expect(pagesSitemap).toContain('<loc>https://example.com/contact/</loc>')
    expect(pagesSitemap).toContain('<loc>https://example.com/posts/</loc>')
    expect(pagesSitemap).not.toContain('<loc>https://example.com/products</loc>')

    expect(existsSync(resolve(artifactDir, 'pages-sitemap.xml'))).toBe(false)
    expect(existsSync(resolve(artifactDir, 'listings-sitemap.xml'))).toBe(false)
    expect(existsSync(resolve(artifactDir, 'taxonomies-sitemap.xml'))).toBe(false)
    expect(existsSync(resolve(artifactDir, 'docs-sitemap.xml'))).toBe(false)
    expect(existsSync(resolve(artifactDir, 'posts-sitemap.xml'))).toBe(false)
  })

  it('fails when configured static sitemap paths do not have route artifacts', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))

    expect(() =>
      writeSplitSitemaps(artifactDir, {
        baseUrl: 'https://example.com',
        listingBasePath: 'products',
        staticPagePaths: ['/', '/missing-page']
      })
    ).toThrow('staticPagePaths without route artifacts: /missing-page')
  })

  it('fails when configured additional sitemap paths do not have route artifacts', () => {
    const artifactDir = makeTempArtifactDir()

    writeFile(resolve(artifactDir, 'index.html'))

    expect(() =>
      writeSplitSitemaps(artifactDir, {
        additionalPathsByGroup: {
          taxonomies: ['/missing-category']
        },
        baseUrl: 'https://example.com',
        listingBasePath: 'products'
      })
    ).toThrow('additionalPathsByGroup without route artifacts: taxonomies:/missing-category')
  })
})
