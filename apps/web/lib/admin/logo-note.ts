import type { AdminListingDetail } from '@serpdirectory/data-ops/admin-queries'
import { formatDateTime } from '../../components/admin/format'

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
      text: `Couldn't host this logo (${queue.lastError ?? 'unknown error'}), so the page shows the fallback tile. Save another image URL to try again.`,
      tone: 'err'
    }
  }
  const failures = queue.attempts
    ? ` after ${queue.attempts} failed attempt${queue.attempts === 1 ? '' : 's'} (${queue.lastError ?? 'unknown error'})`
    : ''
  const next = queue.nextAttemptAt ? ` Next attempt: ${formatDateTime(queue.nextAttemptAt)}.` : ''
  return {
    text: `Waiting to be hosted${failures}; the page shows the fallback tile until then.${next}`,
    tone: 'warn'
  }
}
