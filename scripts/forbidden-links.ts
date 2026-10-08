import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * No listing, product, directory, or rendered page links to the Help Center (`help.serp.co/en`):
 * pages use a product-specific support or issue link instead. `pnpm lint` runs this over the
 * app sources and content; `pnpm audit:forbidden-links` runs it over a built Worker's pages.
 */
export const FORBIDDEN_LISTING_LINK_PATTERN = /\bhttps?:\/\/help\.serp\.co\/en(?:\/|(?=$)|[?#])/gimu

const PROTECTED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.xml'
])

/**
 * The files checked by default. Each must match at least one file (`forbidden-links.test.ts`):
 * a pattern left behind by a move would otherwise pass on nothing (#172).
 */
export const DEFAULT_LINK_LINT_PATTERNS = [
  'apps/*/src/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/public/**/*.{html,json,js,txt,xml}',
  'apps/web/content/**/*.{json,jsonc,md,mdx}'
]

/** Pre-rendered OpenNext assets of the web app, checked with --generated after a Worker build. */
export const GENERATED_LINK_LINT_PATTERNS = [
  'apps/web/.open-next/assets/**/*.{html,json,js,txt,xml}'
]

export interface ForbiddenLink {
  column: number
  line: number
  url: string
}

/** A repository path (relative to the working directory) that pages are built from. */
export function isProtectedListingSurface(filename: string): boolean {
  const path = relative(process.cwd(), resolve(filename)).replace(/\\/gu, '/')
  return path.startsWith('apps/') && PROTECTED_EXTENSIONS.has(path.match(/\.[^.]+$/u)?.[0] ?? '')
}

/** Every Help Center link in `text`, with its 1-based line and column. */
export function findForbiddenLinks(text: string): ForbiddenLink[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  return lines.flatMap((source, index) =>
    [...source.matchAll(new RegExp(FORBIDDEN_LISTING_LINK_PATTERN))].map(match => ({
      column: (match.index ?? 0) + 1,
      line: index + 1,
      url: match[0]
    }))
  )
}

function main(argv: string[]): number {
  const explicit = argv.filter(argument => !argument.startsWith('--'))
  const files =
    explicit.length > 0
      ? explicit
      : globSync(
          argv.includes('--generated') ? GENERATED_LINK_LINT_PATTERNS : DEFAULT_LINK_LINT_PATTERNS,
          {
            exclude: ['**/node_modules/**']
          }
        )
  let failures = 0
  for (const file of files) {
    if (!isProtectedListingSurface(file) || !existsSync(file) || !statSync(file).isFile()) continue
    for (const link of findForbiddenLinks(readFileSync(file, 'utf8'))) {
      failures++
      console.error(
        `${file}:${link.line}:${link.column} Do not link to ${link.url} from listing/product/directory pages. Use a product-specific support or issue link instead.`
      )
    }
  }
  return failures > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
