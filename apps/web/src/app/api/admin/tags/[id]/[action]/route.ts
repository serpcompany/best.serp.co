import { runAdminDecision, unknownAdminEndpoint } from '@/lib/admin/requests'
import { retireTaxonomySchema, taxonomySlugSchema, updateTagSchema } from '@/lib/admin/schemas'
import { retireTag, updateTag } from '@/lib/admin/taxonomy-decisions'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/** A tag's actions (#405), by its slug: `update` (its fields, hub, and slug) and `retire`. */
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ action: string; id: string }>
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  const { action, id } = await params
  const slug = taxonomySlugSchema.safeParse(id)
  if (!slug.success) return unknownAdminEndpoint()
  const actor = authorization.user.email
  switch (action) {
    case 'update':
      return runAdminDecision(request, actor, updateTagSchema, (context, body) =>
        updateTag(context, { ...body, slug: slug.data })
      )
    case 'retire':
      return runAdminDecision(request, actor, retireTaxonomySchema, (context, body) =>
        retireTag(context, { ...body, slug: slug.data })
      )
    default:
      return unknownAdminEndpoint()
  }
}
