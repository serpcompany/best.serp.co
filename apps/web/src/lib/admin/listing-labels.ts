import type { AdminListingRow } from '@/db/admin-queries'

/** Labels the listing screens share (#64 screen 12). */

/** "Admin (import)" for the one-time JSON import, "Admin" for manifests, or "Submission". */
export function sourceLabel(row: Pick<AdminListingRow, 'source' | 'sourceKind'>): string {
  if (row.source === 'submission') return 'Submission'
  return row.sourceKind.startsWith('legacy-') ? 'Admin (import)' : 'Admin'
}

/** The plan column: how a paid or owned listing got there. */
export function planLabel(row: Pick<AdminListingRow, 'ownerVerifiedVia' | 'plan'>): string {
  if (row.ownerVerifiedVia === 'paid_claim') return 'Paid claim'
  if (row.plan === 'paid') return 'Paid'
  if (row.ownerVerifiedVia === 'badge_claim') return 'Free · badge claim'
  return 'Free'
}

const VERIFIED_VIA: Record<string, string> = {
  admin: 'Transferred by an admin',
  badge_claim: 'Badge claim',
  paid_claim: 'Paid claim',
  submission: 'Submission'
}

export function verifiedViaLabel(value: string): string {
  return VERIFIED_VIA[value] ?? value
}
