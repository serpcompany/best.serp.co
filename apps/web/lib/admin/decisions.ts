/**
 * Admin panel decisions (serpcompany/best.serp.co#64): each action reads the current state,
 * answers a replay of a decision that already happened as a no-op, composes the reviewed
 * statement plans from `@serpdirectory/data-ops` (`prepareCatalogPublication` for anything that
 * changes public output), and sends them as one D1 batch. Every plan compares and swaps on the
 * state it read (the submission's `content_version`, the listing checksum, the publication
 * version), so a concurrent or stale decision is refused whole and answered 409.
 *
 * These writes go to the environment's own D1 from the Worker: the documented production-write
 * exception (docs/ADMIN_PANEL.md). The actor is the admin's verified email; each decision is
 * recorded in the submission, revision, or listing events, and in `publication_runs` when it
 * changes the catalog. Emails go through the injected `notify` (the email ledger keys each one,
 * so a retried decision never sends twice).
 *
 * Dependencies are injected, so `decisions.test.ts` runs every action on node:sqlite.
 */
import {
  allowlistEmail,
  buildAddAdminPlans,
  buildRemoveAdminPlans,
  selectAdminAllowlistPlan,
  selectVerifiedUserByEmailPlan
} from '@serpdirectory/data-ops/admin-plans'
import {
  createAdminReadOperations,
  selectActiveUrlBlockPlan
} from '@serpdirectory/data-ops/admin-queries'
import type { Database } from '@serpdirectory/data-ops/client'
import {
  buildRepublishListingPlans,
  buildRevokeListingOwnerPlans,
  buildSetListingLinkRelPlans,
  buildTransferListingOwnerPlans,
  buildUnpublishListingPlans,
  buildUpdateListingDetailsPlans,
  type ListingDetailsEdit,
  selectListingForPublicationPlan
} from '@serpdirectory/data-ops/listing-plans'
import { executePlans, isPlanConflict, queryPlan } from '@serpdirectory/data-ops/plan-runner'
import {
  type CatalogPublication,
  prepareCatalogPublication,
  type StatementPlan
} from '@serpdirectory/data-ops/plan-support'
import {
  buildApproveRevisionPlans,
  buildRejectRevisionPlans,
  buildRequestRevisionChangesPlans,
  selectRevisionForDecisionPlan
} from '@serpdirectory/data-ops/revision-plans'
import type { ListingLinkRel, RejectionCategory } from '@serpdirectory/data-ops/schema'
import {
  buildApproveLiveSubmissionPlans,
  buildApproveSubmissionPlans,
  buildLiftSubmissionUrlBlockPlans,
  buildRejectSubmissionPlans,
  buildReplaceSubmissionContentPlans,
  buildRequestSubmissionChangesPlans,
  selectSubmissionForDecisionPlan,
  submissionTransitions
} from '@serpdirectory/data-ops/submission-plans'
import { hasFileExtension } from '@serpdirectory/utils/file-extensions'
import type { AppEmailTemplates } from '../email/registry'
import type { EmailRequest } from '../email/service'
import type { TemplateInput } from '../email/templates'

/** Sends one of the site's emails after the response (`enqueueEmail` in production). */
export type AdminNotify = <K extends keyof AppEmailTemplates & string>(
  templateId: K,
  request: EmailRequest<TemplateInput<AppEmailTemplates[K]>>
) => Promise<void>

/**
 * Refunds a paid submission's payment through the payment provider (#68). Absent until #68
 * ships, so a paid submission cannot be rejected as `other` (which promises a refund) yet.
 */
export interface AdminRefunds {
  refundRejectedSubmission(input: { actor: string; submissionId: string }): Promise<void>
}

export interface AdminContext {
  /** The admin's verified email: the actor recorded on every decision. */
  actor: string
  client: Database
  /** Builds an email event key (`emailEventKey` in production). */
  eventKey: (event: string, ...ids: string[]) => string
  notify: AdminNotify
  now?: () => Date
  refunds?: AdminRefunds
}

export type DecisionFailure = {
  error: string
  message: string
  ok: false
  status: 404 | 409 | 422 | 503
}

export type Decision<T extends object = object> =
  | ({ ok: true; replayed: boolean } & T)
  | DecisionFailure

const WORKFLOW = 'app/admin'

function failure(
  status: DecisionFailure['status'],
  error: string,
  message: string
): DecisionFailure {
  return { error, message, ok: false, status }
}

const notFound = (what: string) => failure(404, 'not_found', `That ${what} doesn't exist.`)
const changed = failure(
  409,
  'conflict',
  'This changed since you opened it. Reload the page and try again.'
)

function nowIso(context: AdminContext): string {
  return (context.now?.() ?? new Date()).toISOString()
}

function log(context: AdminContext, action: string, target: string, outcome: string): void {
  console.info(
    JSON.stringify({ action, actor: context.actor, event: 'admin_decision', outcome, target })
  )
}

/**
 * Sends the plans; a refused compare-and-swap (or constraint) re-reads the state: if the
 * decision already holds (an identical request won the race) it is a replay, otherwise 409.
 */
async function commit<T extends object>(
  context: AdminContext,
  plans: StatementPlan[],
  settled: () => Promise<boolean>,
  result: T
): Promise<Decision<T>> {
  try {
    await executePlans(context.client, plans)
  } catch (error) {
    if (!isPlanConflict(error)) throw error
    if (await settled()) return { ok: true, replayed: true, ...result }
    return changed
  }
  return { ok: true, replayed: false, ...result }
}

function publicationFor(
  context: AdminContext,
  snapshot: { checksum: string; version: number },
  action: string,
  entityId: string,
  slug: string,
  now: string
): Promise<CatalogPublication> {
  return prepareCatalogPublication({
    action,
    actor: context.actor,
    affectedRoutes: `/products/${slug}/`,
    checksum: snapshot.checksum,
    entityId,
    now,
    version: snapshot.version,
    workflow: WORKFLOW
  })
}

// ---------------------------------------------------------------------------------------------
// Submissions

interface SubmissionSnapshot {
  checksum: string
  content_version: number
  id: string
  listing_id: string | null
  listing_live: number
  paid_at: string | null
  plan: 'free' | 'paid' | null
  refunded_at: string | null
  slug: string
  status: string
  version: number
}

async function submissionSnapshot(
  context: AdminContext,
  submissionId: string
): Promise<SubmissionSnapshot | null> {
  const [row] = await queryPlan<SubmissionSnapshot>(
    context.client,
    selectSubmissionForDecisionPlan(submissionId)
  )
  return row ?? null
}

/** The edits a reviewer may make before approving (screen 11, "Edit before approving"). */
export interface SubmissionEdits {
  categorySlug?: string
  content?: string
  description?: string
  logoUrl?: string
  name?: string
}

const EDIT_FIELDS = ['name', 'categorySlug', 'description', 'logoUrl', 'content'] as const

export async function approveSubmission(
  context: AdminContext,
  input: {
    edits?: SubmissionEdits
    expectedContentVersion: number
    linkRel?: ListingLinkRel
    submissionId: string
  }
): Promise<Decision<{ listingSlug: string }>> {
  const snapshot = await submissionSnapshot(context, input.submissionId)
  if (!snapshot) return notFound('submission')
  const result = { listingSlug: snapshot.slug }
  if (snapshot.status === 'approved') return { ok: true, replayed: true, ...result }
  if (snapshot.status !== 'verified' && snapshot.status !== 'paid_pending_review') {
    return failure(409, 'not_in_review', 'Only a submission in the review queue can be approved.')
  }
  if (snapshot.content_version !== input.expectedContentVersion) return changed
  if (hasFileExtension(snapshot.slug)) {
    return failure(422, 'invalid_slug', `${snapshot.slug} ends in a file extension.`)
  }
  const reads = createAdminReadOperations({ client: context.client })
  const review = await reads.getSubmissionReview(input.submissionId)
  if (!review) return notFound('submission')
  const now = nowIso(context)
  const plans: StatementPlan[] = []
  let version = snapshot.content_version
  const edited = EDIT_FIELDS.filter(field => {
    const value = input.edits?.[field]
    if (value === undefined) return false
    const current = {
      categorySlug: review.categorySlug,
      content: review.content,
      description: review.description,
      logoUrl: review.logoUrl,
      name: review.name
    }[field]
    return value.trim() !== current.trim()
  })
  if (edited.length > 0) {
    const categories = await reads.listActiveCategories()
    const content = {
      categorySlug: input.edits?.categorySlug?.trim() ?? review.categorySlug,
      content: input.edits?.content?.trim() ?? review.content,
      description: input.edits?.description?.trim() ?? review.description,
      faqs: review.faqs,
      logoUrl: input.edits?.logoUrl?.trim() ?? review.logoUrl,
      name: input.edits?.name?.trim() ?? review.name,
      resourceLinks: review.resourceLinks,
      videoUrl: review.videoUrl
    }
    const invalid = validateListingFields(content, categories)
    if (invalid) return invalid
    plans.push(
      ...buildReplaceSubmissionContentPlans({
        actor: context.actor,
        content,
        eventDetail: JSON.stringify({ fields: edited }),
        expectedContentVersion: version,
        expectedStatuses: [snapshot.status as 'verified' | 'paid_pending_review'],
        now,
        submissionId: input.submissionId
      })
    )
    version += 1
  }
  if (snapshot.status === 'verified') {
    const publication = await publicationFor(
      context,
      snapshot,
      'approve-submission',
      input.submissionId,
      snapshot.slug,
      now
    )
    plans.push(
      ...buildApproveSubmissionPlans({
        afterChecksum: publication.afterChecksum,
        affectedRoute: publication.affectedRoutes,
        beforeChecksum: publication.beforeChecksum,
        expectedContentVersion: version,
        linkRel: input.linkRel,
        listingId: snapshot.listing_id ?? `submission_${input.submissionId}`,
        manifestId: publication.manifestId,
        now,
        reviewer: context.actor,
        runId: publication.runId,
        submissionId: input.submissionId,
        version: publication.version,
        workflow: WORKFLOW
      })
    )
  } else {
    const listingId = snapshot.listing_id
    if (!listingId || snapshot.listing_live !== 1) {
      return failure(409, 'listing_down', 'This listing is no longer live. Reject it instead.')
    }
    const publication = await publicationFor(
      context,
      snapshot,
      'approve-live-submission',
      input.submissionId,
      snapshot.slug,
      now
    )
    plans.push(
      ...buildApproveLiveSubmissionPlans({
        expectedContentVersion: version,
        listingId,
        now,
        publication,
        reviewer: context.actor,
        submissionId: input.submissionId
      })
    )
    // The listing already exists, so a changed outbound link is a second publication in the
    // same batch, chained from the approval's version and checksum.
    if (input.linkRel && review.listing && input.linkRel !== review.listing.linkRel) {
      plans.push(
        ...buildSetListingLinkRelPlans({
          linkRel: input.linkRel,
          listingId,
          publication: await publicationFor(
            context,
            { checksum: publication.afterChecksum, version: publication.version + 1 },
            'listing-link-rel',
            listingId,
            snapshot.slug,
            now
          )
        })
      )
    }
  }
  const decision = await commit(
    context,
    plans,
    async () => (await submissionSnapshot(context, input.submissionId))?.status === 'approved',
    result
  )
  log(context, 'approve_submission', input.submissionId, decision.ok ? 'approved' : decision.error)
  // A free listing gets "approved"; a paid one was told it went live when it was paid, and the
  // paid approval email waits for its template (#70).
  if (decision.ok && !decision.replayed && review.submitter && snapshot.plan === 'free') {
    await context.notify('listing-approved', {
      eventKey: context.eventKey('submission-approved', input.submissionId),
      input: {
        listingName: input.edits?.name?.trim() || review.name,
        listingSlug: snapshot.slug,
        website: review.website
      },
      to: review.submitter.email
    })
  }
  return decision
}

export async function requestSubmissionChanges(
  context: AdminContext,
  input: { note: string; submissionId: string }
): Promise<Decision> {
  const note = input.note.trim()
  if (!note) return failure(422, 'note_required', 'Write a note for the submitter.')
  const snapshot = await submissionSnapshot(context, input.submissionId)
  if (!snapshot) return notFound('submission')
  if (snapshot.status === 'changes_requested') return { ok: true, replayed: true }
  if (!(submissionTransitions.requestChanges.from as readonly string[]).includes(snapshot.status)) {
    return failure(409, 'not_in_review', 'Only a submission in the review queue can be sent back.')
  }
  const decision = await commit(
    context,
    buildRequestSubmissionChangesPlans({
      note,
      now: nowIso(context),
      reviewer: context.actor,
      submissionId: input.submissionId
    }),
    async () =>
      (await submissionSnapshot(context, input.submissionId))?.status === 'changes_requested',
    {}
  )
  log(context, 'request_changes', input.submissionId, decision.ok ? 'sent' : decision.error)
  if (decision.ok && !decision.replayed) {
    const review = await createAdminReadOperations({
      client: context.client
    }).getSubmissionReview(input.submissionId)
    if (review?.submitter) {
      // One email per change request: a resubmitted submission can be sent back again.
      const occurrence = review.events.filter(
        event => event.eventType === 'changes_requested'
      ).length
      await context.notify('changes-requested', {
        eventKey: context.eventKey(
          'submission-changes-requested',
          input.submissionId,
          String(occurrence)
        ),
        input: { note, submissionId: input.submissionId, submissionName: review.name },
        to: review.submitter.email
      })
    }
  }
  return decision
}

export async function rejectSubmission(
  context: AdminContext,
  input: { category: RejectionCategory; reason: string; submissionId: string }
): Promise<Decision<{ refunded: boolean }>> {
  const reason = input.reason.trim()
  if (!reason) return failure(422, 'reason_required', 'Write the reason for the rejection.')
  if (input.category !== 'prohibited' && input.category !== 'other') {
    return failure(422, 'category_required', 'Choose a category.')
  }
  const snapshot = await submissionSnapshot(context, input.submissionId)
  if (!snapshot) return notFound('submission')
  if (snapshot.status === 'rejected') return { ok: true, refunded: false, replayed: true }
  if (!(submissionTransitions.reject.from as readonly string[]).includes(snapshot.status)) {
    return failure(409, 'not_rejectable', 'This submission can no longer be rejected.')
  }
  const refundDue =
    input.category === 'other' && snapshot.paid_at !== null && snapshot.refunded_at === null
  if (refundDue && !context.refunds) {
    return failure(
      409,
      'refund_unavailable',
      'Refunds are not available yet, so a paid submission can only be rejected as prohibited for now.'
    )
  }
  const now = nowIso(context)
  const live = snapshot.listing_id
    ? {
        listingId: snapshot.listing_id,
        publication: await publicationFor(
          context,
          snapshot,
          'reject-submission',
          input.submissionId,
          snapshot.slug,
          now
        )
      }
    : undefined
  const decision = await commit(
    context,
    buildRejectSubmissionPlans({
      category: input.category,
      live,
      now,
      reason,
      reviewer: context.actor,
      submissionId: input.submissionId
    }),
    async () => (await submissionSnapshot(context, input.submissionId))?.status === 'rejected',
    { refunded: false }
  )
  log(
    context,
    'reject_submission',
    input.submissionId,
    decision.ok ? input.category : decision.error
  )
  if (!decision.ok || decision.replayed) return decision
  if (refundDue && context.refunds) {
    // #68 refunds through Stripe, records it, and sends "rejected and refunded".
    await context.refunds.refundRejectedSubmission({
      actor: context.actor,
      submissionId: input.submissionId
    })
    return { ...decision, refunded: true }
  }
  const review = await createAdminReadOperations({
    client: context.client
  }).getSubmissionReview(input.submissionId)
  if (review?.submitter) {
    const request = {
      eventKey: context.eventKey('submission-rejected', input.submissionId),
      to: review.submitter.email
    }
    if (input.category === 'prohibited') {
      await context.notify('submission-rejected-prohibited', {
        ...request,
        input: {
          reason,
          submissionId: input.submissionId,
          submissionName: review.name,
          website: review.website
        }
      })
    } else {
      await context.notify('submission-rejected', {
        ...request,
        input: { reason, submissionId: input.submissionId, submissionName: review.name }
      })
    }
  }
  return decision
}

/** "Allow resubmission": lifts the active prohibited-URL block on a block key. */
export async function allowResubmission(
  context: AdminContext,
  input: { urlKey: string }
): Promise<Decision> {
  const urlKey = input.urlKey.trim().toLowerCase()
  if (!urlKey) return failure(422, 'url_key_required', 'Which URL should be allowed again?')
  const blocked = async () =>
    (await queryPlan(context.client, selectActiveUrlBlockPlan(urlKey))).length > 0
  if (!(await blocked())) return { ok: true, replayed: true }
  const decision = await commit(
    context,
    buildLiftSubmissionUrlBlockPlans({
      admin: context.actor,
      note: 'Allowed resubmission from the admin panel.',
      now: nowIso(context),
      urlKey
    }),
    async () => !(await blocked()),
    {}
  )
  log(context, 'allow_resubmission', urlKey, decision.ok ? 'lifted' : decision.error)
  return decision
}

// ---------------------------------------------------------------------------------------------
// Revisions

interface RevisionSnapshot {
  checksum: string
  content_version: number
  listing_id: string
  slug: string
  status: string
  version: number
}

async function revisionSnapshot(
  context: AdminContext,
  revisionId: string
): Promise<RevisionSnapshot | null> {
  const [row] = await queryPlan<RevisionSnapshot>(
    context.client,
    selectRevisionForDecisionPlan(revisionId)
  )
  return row ?? null
}

export async function approveRevision(
  context: AdminContext,
  input: { expectedContentVersion: number; revisionId: string }
): Promise<Decision<{ listingSlug: string }>> {
  const snapshot = await revisionSnapshot(context, input.revisionId)
  if (!snapshot) return notFound('revision')
  const result = { listingSlug: snapshot.slug }
  if (snapshot.status === 'approved') return { ok: true, replayed: true, ...result }
  if (snapshot.status !== 'pending_review') {
    return failure(409, 'not_in_review', 'Only a revision waiting for review can be approved.')
  }
  if (snapshot.content_version !== input.expectedContentVersion) return changed
  const now = nowIso(context)
  const decision = await commit(
    context,
    buildApproveRevisionPlans({
      expectedContentVersion: input.expectedContentVersion,
      listingId: snapshot.listing_id,
      now,
      publication: await publicationFor(
        context,
        snapshot,
        'approve-revision',
        input.revisionId,
        snapshot.slug,
        now
      ),
      reviewer: context.actor,
      revisionId: input.revisionId
    }),
    async () => (await revisionSnapshot(context, input.revisionId))?.status === 'approved',
    result
  )
  log(context, 'approve_revision', input.revisionId, decision.ok ? 'approved' : decision.error)
  return decision
}

export async function requestRevisionChanges(
  context: AdminContext,
  input: { note: string; revisionId: string }
): Promise<Decision> {
  const note = input.note.trim()
  if (!note) return failure(422, 'note_required', 'Write a note for the owner.')
  const snapshot = await revisionSnapshot(context, input.revisionId)
  if (!snapshot) return notFound('revision')
  if (snapshot.status === 'changes_requested') return { ok: true, replayed: true }
  if (snapshot.status !== 'pending_review') {
    return failure(409, 'not_in_review', 'Only a revision waiting for review can be sent back.')
  }
  const decision = await commit(
    context,
    buildRequestRevisionChangesPlans({
      note,
      now: nowIso(context),
      reviewer: context.actor,
      revisionId: input.revisionId
    }),
    async () => (await revisionSnapshot(context, input.revisionId))?.status === 'changes_requested',
    {}
  )
  log(context, 'request_revision_changes', input.revisionId, decision.ok ? 'sent' : decision.error)
  return decision
}

export async function rejectRevision(
  context: AdminContext,
  input: { reason: string; revisionId: string }
): Promise<Decision> {
  const reason = input.reason.trim()
  if (!reason) return failure(422, 'reason_required', 'Write the reason for the rejection.')
  const snapshot = await revisionSnapshot(context, input.revisionId)
  if (!snapshot) return notFound('revision')
  if (snapshot.status === 'rejected') return { ok: true, replayed: true }
  if (snapshot.status !== 'pending_review' && snapshot.status !== 'changes_requested') {
    return failure(409, 'not_rejectable', 'This revision can no longer be rejected.')
  }
  const decision = await commit(
    context,
    buildRejectRevisionPlans({
      now: nowIso(context),
      reason,
      reviewer: context.actor,
      revisionId: input.revisionId
    }),
    async () => (await revisionSnapshot(context, input.revisionId))?.status === 'rejected',
    {}
  )
  log(context, 'reject_revision', input.revisionId, decision.ok ? 'rejected' : decision.error)
  return decision
}

// ---------------------------------------------------------------------------------------------
// Listings

interface ListingSnapshot {
  checksum: string
  id: string
  is_active: number
  link_rel: ListingLinkRel
  owner_user_id: string | null
  publication_checksum: string
  slug: string
  status: string
  version: number
}

async function listingSnapshot(
  context: AdminContext,
  listingId: string
): Promise<ListingSnapshot | null> {
  const [row] = await queryPlan<ListingSnapshot>(
    context.client,
    selectListingForPublicationPlan(listingId)
  )
  return row ?? null
}

function listingPublication(
  context: AdminContext,
  snapshot: ListingSnapshot,
  action: string,
  now: string
): Promise<CatalogPublication> {
  return publicationFor(
    context,
    { checksum: snapshot.publication_checksum, version: snapshot.version },
    action,
    snapshot.id,
    snapshot.slug,
    now
  )
}

const NAME_MAX = 80
const DESCRIPTION_MAX = 160

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Field rules shared by the reviewer's inline edit and the listing details form. */
export function validateListingFields(
  fields: {
    categorySlug: string
    description: string
    logoUrl: string
    name: string
    website?: string
  },
  categories: ReadonlyArray<{ slug: string }>
): DecisionFailure | null {
  const name = fields.name.trim()
  if (!name || name.length > NAME_MAX) {
    return failure(422, 'invalid_name', `The name needs 1 to ${NAME_MAX} characters.`)
  }
  const description = fields.description.trim()
  if (!description || description.length > DESCRIPTION_MAX) {
    return failure(
      422,
      'invalid_description',
      `The short description needs 1 to ${DESCRIPTION_MAX} characters.`
    )
  }
  if (!categories.some(category => category.slug === fields.categorySlug)) {
    return failure(422, 'invalid_category', 'Choose an active category.')
  }
  if (!isWebUrl(fields.logoUrl.trim())) {
    return failure(422, 'invalid_logo', 'The logo needs an http or https image URL.')
  }
  if (fields.website !== undefined && !isWebUrl(fields.website.trim())) {
    return failure(422, 'invalid_website', 'The website needs an http or https URL.')
  }
  return null
}

export async function updateListingDetails(
  context: AdminContext,
  input: { details: ListingDetailsEdit; expectedChecksum: string; listingId: string }
): Promise<Decision<{ fields: string[] }>> {
  const snapshot = await listingSnapshot(context, input.listingId)
  if (!snapshot) return notFound('listing')
  const reads = createAdminReadOperations({ client: context.client })
  const current = await reads.getAdminListing(snapshot.slug)
  if (!current) return notFound('listing')
  const invalid = validateListingFields(input.details, await reads.listActiveCategories())
  if (invalid) return invalid
  const details = {
    categorySlug: input.details.categorySlug.trim(),
    description: input.details.description.trim(),
    logoUrl: input.details.logoUrl.trim(),
    name: input.details.name.trim(),
    website: input.details.website.trim()
  }
  const fields = [
    details.name !== current.name ? 'name' : null,
    details.categorySlug !== current.categorySlug ? 'category' : null,
    details.website !== current.website ? 'website' : null,
    details.description !== current.description ? 'description' : null,
    details.logoUrl !== (current.logoUrl ?? '') ? 'logo' : null
  ].filter((field): field is string => field !== null)
  if (snapshot.checksum !== input.expectedChecksum) {
    return fields.length === 0 ? { fields, ok: true, replayed: true } : changed
  }
  if (fields.length === 0) return { fields, ok: true, replayed: true }
  if (current.submissionQueued) {
    return failure(
      409,
      'submission_in_review',
      "This listing's submission is in review. Edit it on the review page."
    )
  }
  if (current.adminStatus === 'blocked' || current.adminStatus === 'rejected') {
    return failure(409, 'listing_rejected', 'A rejected listing is read-only.')
  }
  const decision = await commit(
    context,
    buildUpdateListingDetailsPlans({
      details,
      expectedChecksum: input.expectedChecksum,
      fields,
      listingId: input.listingId,
      publication: await listingPublication(context, snapshot, 'listing-edit', nowIso(context))
    }),
    async () => false,
    { fields }
  )
  log(context, 'edit_listing', input.listingId, decision.ok ? fields.join(',') : decision.error)
  return decision
}

export async function unpublishListing(
  context: AdminContext,
  input: { listingId: string; note?: string }
): Promise<Decision> {
  const snapshot = await listingSnapshot(context, input.listingId)
  if (!snapshot) return notFound('listing')
  if (snapshot.status === 'approved' && snapshot.is_active === 0) {
    return { ok: true, replayed: true }
  }
  const current = await createAdminReadOperations({ client: context.client }).getAdminListing(
    snapshot.slug
  )
  if (current?.submissionQueued) {
    return failure(
      409,
      'submission_in_review',
      "This listing's submission is in review. Reject it on the review page instead."
    )
  }
  if (snapshot.status !== 'approved') {
    return failure(409, 'not_live', 'Only a published listing can be unpublished.')
  }
  const decision = await commit(
    context,
    buildUnpublishListingPlans({
      listingId: input.listingId,
      note: input.note,
      publication: await listingPublication(
        context,
        snapshot,
        'listing-unpublish',
        nowIso(context)
      ),
      reason: 'admin'
    }),
    async () => (await listingSnapshot(context, input.listingId))?.is_active === 0,
    {}
  )
  log(context, 'unpublish_listing', input.listingId, decision.ok ? 'unpublished' : decision.error)
  return decision
}

export async function republishListing(
  context: AdminContext,
  input: { listingId: string }
): Promise<Decision> {
  const snapshot = await listingSnapshot(context, input.listingId)
  if (!snapshot) return notFound('listing')
  if (snapshot.status === 'approved' && snapshot.is_active === 1) {
    return { ok: true, replayed: true }
  }
  const current = await createAdminReadOperations({ client: context.client }).getAdminListing(
    snapshot.slug
  )
  if (current?.adminStatus === 'blocked' || current?.adminStatus === 'rejected') {
    return failure(
      409,
      'listing_rejected',
      'A rejected listing comes back only through a new submission.'
    )
  }
  const decision = await commit(
    context,
    buildRepublishListingPlans({
      listingId: input.listingId,
      publication: await listingPublication(context, snapshot, 'listing-republish', nowIso(context))
    }),
    async () => (await listingSnapshot(context, input.listingId))?.is_active === 1,
    {}
  )
  log(context, 'republish_listing', input.listingId, decision.ok ? 'republished' : decision.error)
  return decision
}

export async function setListingLinkRel(
  context: AdminContext,
  input: { linkRel: ListingLinkRel; listingId: string }
): Promise<Decision> {
  if (!['follow', 'nofollow', 'sponsored'].includes(input.linkRel)) {
    return failure(422, 'invalid_link_rel', 'Choose follow, nofollow, or sponsored.')
  }
  const snapshot = await listingSnapshot(context, input.listingId)
  if (!snapshot) return notFound('listing')
  if (snapshot.link_rel === input.linkRel) return { ok: true, replayed: true }
  const decision = await commit(
    context,
    buildSetListingLinkRelPlans({
      linkRel: input.linkRel,
      listingId: input.listingId,
      publication: await listingPublication(context, snapshot, 'listing-link-rel', nowIso(context))
    }),
    async () => (await listingSnapshot(context, input.listingId))?.link_rel === input.linkRel,
    {}
  )
  log(context, 'set_link_rel', input.listingId, decision.ok ? input.linkRel : decision.error)
  return decision
}

export async function transferListingOwner(
  context: AdminContext,
  input: { email: string; expectedOwnerUserId: string | null; listingId: string }
): Promise<Decision<{ ownerEmail: string }>> {
  const email = input.email.trim().toLowerCase()
  if (!email) return failure(422, 'email_required', "Enter the new owner's email.")
  const [user] = await queryPlan<{ email: string; id: string }>(
    context.client,
    selectVerifiedUserByEmailPlan(email)
  )
  if (!user) {
    return failure(
      422,
      'no_account',
      `${email} has no SERP account yet. They need to sign in once before you can transfer.`
    )
  }
  const snapshot = await listingSnapshot(context, input.listingId)
  if (!snapshot) return notFound('listing')
  const result = { ownerEmail: user.email }
  if (snapshot.owner_user_id === user.id) return { ok: true, replayed: true, ...result }
  if (snapshot.owner_user_id !== input.expectedOwnerUserId) return changed
  const decision = await commit(
    context,
    buildTransferListingOwnerPlans({
      fromUserId: snapshot.owner_user_id,
      listingId: input.listingId,
      publication: await listingPublication(context, snapshot, 'listing-transfer', nowIso(context)),
      toUserId: user.id
    }),
    async () => (await listingSnapshot(context, input.listingId))?.owner_user_id === user.id,
    result
  )
  log(context, 'transfer_owner', input.listingId, decision.ok ? 'transferred' : decision.error)
  return decision
}

export async function removeListingOwner(
  context: AdminContext,
  input: { expectedOwnerUserId: string; listingId: string }
): Promise<Decision> {
  const snapshot = await listingSnapshot(context, input.listingId)
  if (!snapshot) return notFound('listing')
  if (snapshot.owner_user_id === null) return { ok: true, replayed: true }
  if (snapshot.owner_user_id !== input.expectedOwnerUserId) return changed
  const decision = await commit(
    context,
    buildRevokeListingOwnerPlans({
      listingId: input.listingId,
      publication: await listingPublication(
        context,
        snapshot,
        'listing-owner-remove',
        nowIso(context)
      ),
      reason: 'admin_removed',
      userId: snapshot.owner_user_id
    }),
    async () => (await listingSnapshot(context, input.listingId))?.owner_user_id === null,
    {}
  )
  log(context, 'remove_owner', input.listingId, decision.ok ? 'removed' : decision.error)
  return decision
}

// ---------------------------------------------------------------------------------------------
// Admins

async function allowlist(context: AdminContext): Promise<string[]> {
  return (await queryPlan<{ email: string }>(context.client, selectAdminAllowlistPlan())).map(
    row => row.email
  )
}

export async function addAdmin(
  context: AdminContext,
  input: { email: string }
): Promise<Decision<{ email: string }>> {
  let email: string
  try {
    email = allowlistEmail(input.email)
  } catch {
    return failure(422, 'invalid_email', 'Enter a valid email address.')
  }
  if ((await allowlist(context)).includes(email)) {
    return failure(409, 'already_admin', `${email} is already an admin.`)
  }
  const decision = await commit(
    context,
    buildAddAdminPlans({ addedBy: context.actor, email }),
    async () => false,
    { email }
  )
  log(context, 'add_admin', email, decision.ok ? 'added' : decision.error)
  return decision.ok ? decision : failure(409, 'already_admin', `${email} is already an admin.`)
}

export async function removeAdmin(
  context: AdminContext,
  input: { email: string }
): Promise<Decision<{ email: string }>> {
  let email: string
  try {
    email = allowlistEmail(input.email)
  } catch {
    return failure(422, 'invalid_email', 'Enter a valid email address.')
  }
  const current = await allowlist(context)
  if (!current.includes(email)) return { email, ok: true, replayed: true }
  const lastAdmin = failure(409, 'last_admin', 'The last admin can’t be removed.')
  if (current.length <= 1) return lastAdmin
  const decision = await commit(
    context,
    buildRemoveAdminPlans({ email }),
    async () => !(await allowlist(context)).includes(email),
    { email }
  )
  log(context, 'remove_admin', email, decision.ok ? 'removed' : decision.error)
  return decision.ok ? decision : lastAdmin
}
