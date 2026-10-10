import { type SiteFeatures, features as siteFeatures } from '../features'

/** The Worker vars that decide whether the badge program runs (`ScheduledEnv` has them all). */
export interface BadgeProgramEnv {
  D1_RUNTIME_ENV?: string
  LOCAL_BADGE_PROGRAM?: string
  SITE_ENVIRONMENT?: string
}

/**
 * The badge program runs only while `features.badgeProgram` is on (on since #130, the owner's
 * launch decision), or on a local Worker that asks for it. Kept apart from the scheduled jobs
 * (`lib/worker/scheduled.ts`) so a listing page can read it without loading them (#334).
 */
export function badgeProgramEnabled(
  env: BadgeProgramEnv,
  features: SiteFeatures = siteFeatures
): boolean {
  if (features.badgeProgram) return true
  return (
    env.LOCAL_BADGE_PROGRAM === 'on' &&
    env.SITE_ENVIRONMENT === 'local' &&
    env.D1_RUNTIME_ENV === 'local'
  )
}
