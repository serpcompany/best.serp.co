import 'server-only'

import { getCloudflareContext } from '@opennextjs/cloudflare'
import { type BadgeProgramEnv, badgeProgramEnabled } from '@/lib/badge-program/enabled'
import { featureCopy } from '@/lib/feature-copy'
import { features as siteFeatures } from '@/lib/features'
import { type ClaimFlags, claimFlags } from './flags'

/**
 * This Worker's claim flags and the claim dialog's copy (#67), for the listing page and the claim
 * endpoints. Only the flags' own modules load here: the claim flow's dependencies (Better Auth,
 * email, the scheduled jobs) stay in `./runtime`, so an uncached listing page never loads them
 * (#334).
 */

interface CurrentClaimEnv extends BadgeProgramEnv {
  LOCAL_CLAIMS?: string
  LOCAL_ORDERS?: string
}

async function claimEnv(): Promise<CurrentClaimEnv> {
  const { env } = await getCloudflareContext({ async: true })
  return env as unknown as CurrentClaimEnv
}

/** Whether claims are on for this Worker (`features.claims`, or a local Worker that asks). */
export async function currentClaimFlags(): Promise<ClaimFlags> {
  return claimFlags(await claimEnv(), siteFeatures)
}

/**
 * The claim dialog's flagged copy (`featureCopy().claim`): it promises weekly checks only while
 * the badge program actually runs on this Worker (#66, `badgeProgramEnabled`).
 */
export async function currentClaimCopy() {
  const env = await claimEnv()
  return featureCopy({ ...siteFeatures, badgeProgram: badgeProgramEnabled(env, siteFeatures) })
    .claim
}
