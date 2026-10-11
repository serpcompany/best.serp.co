import { runAdminDecision } from '@/lib/admin/requests'
import { createTagSchema } from '@/lib/admin/schemas'
import { createTag } from '@/lib/admin/taxonomy-decisions'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/** Creates a tag under a category (#405): `name`, `slug`, `description`, `category`. */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, createTagSchema, createTag)
}
