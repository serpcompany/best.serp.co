import { isMediaKey, mediaUrl } from '@serpdirectory/data-ops/media-keys'

/**
 * The image an admin or preview screen may render for a logo (#96 review S9): the hosted copy on
 * the environment's media host, or a site-relative path on our own origin (an imported logo the
 * legacy migration has not repointed yet). A source URL on someone else's host is never
 * rendered as an image: the screens show the fallback tile and link to the source instead.
 */
export function renderableImage(
  input: { key?: string | null; url?: string | null },
  mediaBaseUrl: string
): string | null {
  if (input.key && isMediaKey(input.key)) return mediaUrl(input.key, mediaBaseUrl)
  const url = input.url?.trim()
  if (url?.startsWith('/') && !url.startsWith('//')) return url
  return null
}
