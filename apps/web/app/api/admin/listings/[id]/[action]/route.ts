import { z } from 'zod'
import {
  allowResubmission,
  removeListingOwner,
  republishListing,
  setListingLinkRel,
  transferListingOwner,
  unpublishListing,
  updateListingDetails
} from '@/lib/admin/decisions'
import { runAdminDecision, unknownAdminEndpoint } from '@/lib/admin/requests'
import {
  allowResubmissionSchema,
  decisionIdSchema,
  linkRelSchema,
  listingDetailsSchema,
  removeOwnerSchema,
  transferOwnerSchema,
  unpublishListingSchema
} from '@/lib/admin/schemas'
import { authorizationErrorResponse } from '@/lib/auth/guards'
import { authorizeAdminRequest } from '@/lib/auth/server'

/**
 * Listing actions (#64 screen 12): `details`, `unpublish`, `republish`, `link-rel`,
 * `transfer-owner`, `remove-owner`, and `allow-resubmission`.
 */
export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ action: string; id: string }>
}

const emptyBody = z.object({}).passthrough()

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return authorizationErrorResponse(authorization)
  const { action, id } = await params
  const listingId = decisionIdSchema.safeParse(id)
  if (!listingId.success) return unknownAdminEndpoint()
  const actor = authorization.user.email
  const target = { listingId: listingId.data }
  switch (action) {
    case 'details':
      return runAdminDecision(request, actor, listingDetailsSchema, (context, body) =>
        updateListingDetails(context, { ...body, ...target })
      )
    case 'unpublish':
      return runAdminDecision(request, actor, unpublishListingSchema, (context, body) =>
        unpublishListing(context, { ...body, ...target })
      )
    case 'republish':
      return runAdminDecision(request, actor, emptyBody, context =>
        republishListing(context, target)
      )
    case 'link-rel':
      return runAdminDecision(request, actor, linkRelSchema, (context, body) =>
        setListingLinkRel(context, { ...body, ...target })
      )
    case 'transfer-owner':
      return runAdminDecision(request, actor, transferOwnerSchema, (context, body) =>
        transferListingOwner(context, { ...body, ...target })
      )
    case 'remove-owner':
      return runAdminDecision(request, actor, removeOwnerSchema, (context, body) =>
        removeListingOwner(context, { ...body, ...target })
      )
    case 'allow-resubmission':
      return runAdminDecision(request, actor, allowResubmissionSchema, (context, body) =>
        allowResubmission(context, body)
      )
    default:
      return unknownAdminEndpoint()
  }
}
