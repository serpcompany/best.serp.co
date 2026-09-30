import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import withBundleAnalyzer from '@next/bundle-analyzer'
import withVercelToolbar from '@vercel/toolbar/plugins/next'
import type { NextConfig } from 'next'

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

export function resolveDeterministicBuildId(
  siteId = process.env.NEXT_PUBLIC_SITE_ID || process.env.SITE_ID || 'default'
): string {
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

/**
 * Wraps a Next.js config with bundle analyzer support
 */
export const withAnalyzer = (sourceConfig: NextConfig) => withBundleAnalyzer()(sourceConfig)

/**
 * Wraps a Next.js config with Vercel toolbar support
 */
export const withVercelToolbarConfig = (sourceConfig: NextConfig) =>
  withVercelToolbar()(sourceConfig)
