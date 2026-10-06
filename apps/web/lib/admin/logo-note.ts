import type { AdminListingDetail } from '@serpdirectory/data-ops/admin-queries'
import { formatDateTime } from '../../components/admin/format'

const failureText: Record<string, string> = {
  copy_mismatch: "the stored copy didn't match its record",
  corrupt_image: 'the file is damaged or incomplete',
  fetch_timeout: 'the site took too long to answer',
  image_too_small: 'the image is too small',
  invalid_redirect: 'it redirected to an address that is not a public HTTP(S) URL',
  invalid_target: 'the URL is not a public HTTP(S) address on port 80 or 443',
  read_failed: 'the download broke off',
  reviewed_copy_changed:
    'the reviewed copy is gone and the source now serves different bytes, which are never published',
  reviewed_copy_missing: 'the reviewed copy is gone and the source no longer serves it',
  response_too_large: 'the file is larger than 5 MB',
  site_unreachable: "the site couldn't be reached",
  store_failed: "the copy couldn't be stored",
  svg: "it is an SVG, which can't be hosted",
  too_many_pixels: 'the image has more than 40 megapixels',
  too_many_redirects: 'it redirected too many times',
  unexpected_type: 'the URL answered with a web page, not an image',
  unknown_format: 'it is not a PNG, JPG, WebP, GIF, AVIF or ICO image',
  unreadable_dimensions: "the image's size can't be read"
}

/** A media failure code (`MediaFetchFailure`) in words, with the code for support. */
export function describeMediaFailure(code: string): string {
  const status = /^http_(\d{3})$/u.exec(code)?.[1]
  const text = status ? `the server answered HTTP ${status}` : failureText[code]
  return text ? `${text} (${code})` : code
}

/**
 * Why the logo shows the fallback tile while it is not hosted yet (#95): waiting for the media
 * cron, or given up with the reason. Null when the logo is hosted (or there is none).
 */
export function logoNote(
  queue: AdminListingDetail['logoQueue'],
  /** A hosted logo stays on the page while its replacement is queued (#96 round 2 S2). */
  hostedLogo = false
): { text: string; tone: 'err' | 'warn' } | null {
  if (!queue) return null
  if (hostedLogo) {
    if (queue.status === 'failed') {
      return {
        text: `Couldn't host the new logo: ${describeMediaFailure(queue.lastError ?? 'unknown error')}. The page keeps the current logo. Save another image URL, or the current logo's URL to cancel.`,
        tone: 'err'
      }
    }
    const tried = queue.attempts
      ? ` after ${queue.attempts} failed attempt${queue.attempts === 1 ? '' : 's'}: ${describeMediaFailure(queue.lastError ?? 'unknown error')}`
      : ''
    const next = queue.nextAttemptAt ? ` Next attempt: ${formatDateTime(queue.nextAttemptAt)}.` : ''
    return {
      text: `New logo pending${tried}. The page keeps the current logo until the new one is hosted; save the current logo's URL to cancel.${next}`,
      tone: 'warn'
    }
  }
  if (queue.status === 'failed') {
    return {
      text: `Couldn't host this logo: ${describeMediaFailure(queue.lastError ?? 'unknown error')}. The page shows the fallback tile. Save another image URL to try again.`,
      tone: 'err'
    }
  }
  const failures = queue.attempts
    ? ` after ${queue.attempts} failed attempt${queue.attempts === 1 ? '' : 's'}: ${describeMediaFailure(queue.lastError ?? 'unknown error')}`
    : ''
  const next = queue.nextAttemptAt ? ` Next attempt: ${formatDateTime(queue.nextAttemptAt)}.` : ''
  return {
    text: `Waiting to be hosted${failures}; the page shows the fallback tile until then.${next}`,
    tone: 'warn'
  }
}
