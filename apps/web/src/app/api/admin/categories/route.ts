import { runAdminDecision } from '@/lib/admin/requests'
import { createCategorySchema } from '@/lib/admin/schemas'
import { createCategory } from '@/lib/admin/taxonomy-decisions'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/** Creates a category, a hub (#405): `name`, `slug`, `description`, `order`. */
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  return runAdminDecision(request, authorization.user.email, createCategorySchema, createCategory)
}
