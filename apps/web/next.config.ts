import path from 'node:path'
import { withContentCollections } from '@content-collections/next'
import withMDX from '@next/mdx'
import { baseConfig, withAnalyzer } from '@serpdirectory/config-next'
import { site } from '@serpdirectory/site-config'
import type { NextConfig } from 'next'

export const INTERNAL_PACKAGES = [
  '@serpdirectory/design-system',
  '@serpdirectory/config-next',
  '@serpdirectory/config-typescript',
  '@serpdirectory/content',
  '@serpdirectory/logging',
  '@serpdirectory/site-config',
  '@serpdirectory/utils',
  '@serpdirectory/web-core'
]

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/^\/+|\/+$/g, '')
}

function buildPublicRoute(basePath: string): string {
  return `/${normalizeBasePath(basePath)}`
}

function createAliasRewrites(sourceBasePath: string, destinationBasePath: string) {
  if (sourceBasePath === destinationBasePath) {
    return []
  }

  return [
    {
      source: buildPublicRoute(sourceBasePath),
      destination: buildPublicRoute(destinationBasePath)
    },
    {
      source: `${buildPublicRoute(sourceBasePath)}/:path*`,
      destination: `${buildPublicRoute(destinationBasePath)}/:path*`
    }
  ]
}

const listingBasePath = normalizeBasePath(site.routes.listingBasePath)
const docsBasePath = normalizeBasePath(site.routes.docsBasePath)
const networkBasePath = normalizeBasePath(site.routes.networkBasePath)
const brandsBasePath = normalizeBasePath(site.routes.brandsBasePath)
let nextConfig: NextConfig = {
  ...baseConfig,

  transpilePackages: INTERNAL_PACKAGES,

  pageExtensions: ['mdx', 'ts', 'tsx'],

  // Configure logging behavior
  logging: {
    fetches: {
      fullUrl: process.env.NODE_ENV === 'development'
    }
  },

  // Configure Turbopack (default bundler in Next.js 16)
  turbopack: {
    root: path.resolve(process.cwd(), '../..'),
    resolveExtensions: ['.mdx', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    resolveAlias: {
      crypto: { browser: './turbopack-empty.ts' },
      stream: { browser: './turbopack-empty.ts' },
      buffer: { browser: './turbopack-empty.ts' },
      util: { browser: './turbopack-empty.ts' },
      fs: { browser: './turbopack-empty.ts' },
      path: { browser: './turbopack-empty.ts' },
      'node:crypto': { browser: './turbopack-empty.ts' },
      'node:stream': { browser: './turbopack-empty.ts' },
      'node:buffer': { browser: './turbopack-empty.ts' },
      'node:util': { browser: './turbopack-empty.ts' },
      'node:fs': { browser: './turbopack-empty.ts' },
      'node:path': { browser: './turbopack-empty.ts' }
    }
  },

  images: {
    unoptimized: false,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'icon.horse',
        pathname: '/icon/**'
      }
    ]
  },

  trailingSlash: true,

  headers: async () => [
    {
      // Staging runs on a public *.workers.dev hostname; keep it out of search indexes.
      source: '/:path*',
      has: [{ type: 'host', value: '.*\\.workers\\.dev' }],
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]
    },
    {
      source: '/admin/submissions/:path*',
      headers: [
        { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }
      ]
    }
  ],

  rewrites: async () => ({
    beforeFiles: [
      ...createAliasRewrites(docsBasePath, 'docs'),
      ...createAliasRewrites(networkBasePath, 'projects'),
      ...createAliasRewrites(brandsBasePath, 'brands'),
      ...createAliasRewrites('posts', 'guides')
    ]
  }),

  redirects: async () => {
    return [
      {
        source: '/news',
        destination: '/',
        permanent: false
      },
      // Pre-D1 URL scheme (serpcompany/best.serp.co#34): /products/<slug>/reviews/ and
      // /products/best/<category>/. "featured" is a placement flag, not a public page.
      {
        source: '/products/:slug/reviews',
        destination: '/products/:slug/',
        permanent: true
      },
      ...['/products/best', '/products/best/featured', '/categories', '/categories/featured'].map(
        source => ({ source, destination: '/products/categories/', permanent: true })
      ),
      {
        source: '/products/best/:category',
        destination: '/products/categories/:category/',
        permanent: true
      },
      {
        source: '/categories/:category',
        destination: '/products/categories/:category/',
        permanent: true
      },
      {
        source: '/website/:path*',
        destination: `${buildPublicRoute(listingBasePath)}/:path*`,
        permanent: true
      },
      ...createAliasRewrites('websites', listingBasePath).map(rule => ({
        ...rule,
        permanent: true
      })),
      ...createAliasRewrites('docs', docsBasePath).map(rule => ({
        ...rule,
        permanent: true
      })),
      ...createAliasRewrites('projects', networkBasePath).map(rule => ({
        ...rule,
        permanent: true
      })),
      ...createAliasRewrites('brands', brandsBasePath).map(rule => ({
        ...rule,
        permanent: true
      })),
      ...createAliasRewrites('guides', 'posts').map(rule => ({
        ...rule,
        permanent: true
      }))
    ]
  }
}

// Apply other plugins first
nextConfig = withMDX()(nextConfig)

if (process.env.ANALYZE === 'true') {
  nextConfig = withAnalyzer(nextConfig)
}

// withContentCollections must be the outermost wrapper
export default withContentCollections(nextConfig)
