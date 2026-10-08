import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { withContentCollections } from '@content-collections/next'
import withBundleAnalyzer from '@next/bundle-analyzer'
import withMDX from '@next/mdx'
import { withSentryConfig } from '@sentry/nextjs/config'
import { site } from './src/lib/site'
import type { NextConfig } from 'next'
import { movedUrlRedirects } from './src/lib/routing/redirects'
import { sentryRelease } from './src/lib/telemetry/sentry'

export const INTERNAL_PACKAGES = ['@serpdirectory/design-system', '@serpdirectory/utils']

const BUILD_ID_HASH_LENGTH = 20

function readGitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

/** One build ID per site and source revision, so every build of a commit agrees. */
export function resolveDeterministicBuildId(siteId = 'best.serp.co'): string {
  const sourceRevision =
    process.env.NEXT_BUILD_ID ||
    process.env.GITHUB_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    readGitHead() ||
    'local'

  return createHash('sha256')
    .update(`${siteId}:${sourceRevision}`)
    .digest('hex')
    .slice(0, BUILD_ID_HASH_LENGTH)
}

export const baseConfig: NextConfig = {
  generateBuildId: async () => resolveDeterministicBuildId(),
  reactStrictMode: true,
  skipTrailingSlashRedirect: true
}

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

const docsBasePath = normalizeBasePath(site.routes.docsBasePath)
const networkBasePath = normalizeBasePath(site.routes.networkBasePath)
const brandsBasePath = normalizeBasePath(site.routes.brandsBasePath)
let nextConfig: NextConfig = {
  ...baseConfig,

  transpilePackages: INTERNAL_PACKAGES,

  // `unauthorized()` / `forbidden()` give admin pages real 401 and 403 responses
  // (`requireAdmin()` in src/lib/auth/server.ts; docs/ACCOUNTS.md).
  experimental: {
    authInterrupts: true
  },

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
      },
      // Hosted listing media (#95): production and staging media hosts, this site's keys only.
      {
        protocol: 'https',
        hostname: 'cdn.serp.co',
        pathname: '/best.serp.co/listings/**'
      },
      {
        protocol: 'https',
        hostname: 'cdn-staging.serp.co',
        pathname: '/best.serp.co/listings/**'
      }
    ]
  },

  // Pages are written with a trailing slash. `skipTrailingSlashRedirect` (in `baseConfig`)
  // turns off the framework's own slash redirect, which differs
  // between Next.js and OpenNext and has no /api exception; the Worker entry enforces the
  // URL trailing-slash standard instead (`src/lib/routing/trailing-slash.ts`).
  trailingSlash: true,

  headers: async () => [
    {
      // Defense in depth: the Worker entry sends noindex on every response outside public
      // production (SITE_ENVIRONMENT, docs/ARCHITECTURE.md#environments-and-hosts). This host
      // rule keeps the *.workers.dev hosts out of search indexes even if that config is wrong.
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

  // Moved URLs (legacy routes and aliases): see src/lib/routing/redirects.ts.
  redirects: async () => movedUrlRedirects()
}

// Apply other plugins first
nextConfig = withMDX()(nextConfig)

if (process.env.ANALYZE === 'true') {
  nextConfig = withBundleAnalyzer()(nextConfig)
}

// Sentry (#48): uploads source maps and creates the release only when the deploy build has the
// auth token; every other build (PRs, local) skips both and needs no network.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || undefined
nextConfig = withSentryConfig(nextConfig, {
  authToken: sentryAuthToken,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  release: {
    create: Boolean(sentryAuthToken),
    name: sentryRelease(process.env.NEXT_PUBLIC_SENTRY_RELEASE)
  },
  silent: !process.env.CI,
  sourcemaps: { deleteSourcemapsAfterUpload: true, disable: !sentryAuthToken },
  telemetry: false,
  widenClientFileUpload: true
})
// withSentryConfig always adds `sentry-trace` and `baggage` meta tags for pageload tracing.
// Tracing is off, and behind the edge HTML cache every visitor would share one trace id.
if (nextConfig.experimental) delete nextConfig.experimental.clientTraceMetadata

// withContentCollections must be the outermost wrapper
export default withContentCollections(nextConfig)
