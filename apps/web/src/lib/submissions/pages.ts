import 'server-only'

import { notFound, redirect } from 'next/navigation'
import type { SessionUser } from '@/lib/auth/guards'
import { getSessionUser } from '@/lib/auth/server'
import { getOwnSubmission, type OwnSubmission } from './repository'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * The signed-in owner's submission for a submit-flow page (`/submit/<id>/...`, #63). Signed-out
 * visitors go to `/login` and come back to `path`; anyone else's submission, or an unknown
 * id, is a 404, so ids reveal nothing.
 */
export async function ownSubmissionForPage(
  id: string,
  path: string
): Promise<{ submission: OwnSubmission; user: SessionUser }> {
  if (!UUID.test(id)) notFound()
  const user = await getSessionUser()
  if (!user) redirect(`/login/?callbackUrl=${encodeURIComponent(path)}`)
  const submission = await getOwnSubmission(id, user.id)
  if (!submission) notFound()
  return { submission, user }
}
