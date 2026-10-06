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
  queue: AdminListingDetail['logoQueue']
): { text: string; tone: 'err' | 'warn' } | null {
  if (!queue) return null
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
