import { runAdminDecision } from '@/lib/admin/requests'
import { createBestPageSchema } from '@/lib/admin/schemas'
import { createBestPage } from '@/lib/admin/taxonomy-decisions'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/** Creates a best page (#405): `keyword`, `slug`, `title`, `intro`, and the `tag` it ranks. */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, createBestPageSchema, createBestPage)
}
