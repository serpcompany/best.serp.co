/**
 * Extensions that make a URL path a file rather than a page (SERP URL trailing-slash
 * standard: files never end with a slash, pages always do).
 *
 * Listing slugs are domain names (`autoenhance.ai`, `aws.amazon.com`), so "has an
 * extension" cannot mean "contains a dot": only these mark a file. None of them is a
 * top-level domain; never add one that is (`.zip`, `.mov`, `.md`, `.app`, ...), or listing
 * pages under that TLD would lose their trailing slash. Slug validation (submissions and
 * reviewed publications) rejects a slug that ends in one of these, so a page URL can never
 * look like a file.
 */
export const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'atom',
  'avif',
  'css',
  'csv',
  'eot',
  'gif',
  'htm',
  'html',
  'ico',
  'jpeg',
  'jpg',
  'js',
  'json',
  'map',
  'mjs',
  'mp3',
  'mp4',
  'otf',
  'pdf',
  'png',
  'rss',
  'svg',
  'ttf',
  'txt',
  'wasm',
  'webm',
  'webmanifest',
  'webp',
  'woff',
  'woff2',
  'xml'
])

/** True when a name (a path segment or slug) ends in one of `FILE_EXTENSIONS`. */
export function hasFileExtension(name: string): boolean {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]
  return extension !== undefined && FILE_EXTENSIONS.has(extension.toLowerCase())
}
