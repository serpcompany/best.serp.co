/**
 * Credential-free statement plans (serpcompany/best.serp.co#62). A plan is an ordered list of
 * prepared statements that a caller sends as one D1 batch (one transaction). Every transition
 * is a compare-and-swap: the mutating statement repeats the expected state in its `WHERE`, and
 * the next statement asserts `changes() = 1`, so a stale or concurrent decision fails the whole
 * batch and leaves nothing behind.
 */
export interface StatementPlan {
  params: unknown[]
  sql: string
}

/** A SQL boolean expression and its bindings. */
export interface PlanGuard {
  params: unknown[]
  sql: string
}

/**
 * SQLite evaluates only the selected CASE branch. A zero-row or multi-row
 * conditional transition therefore reaches malformed JSON and fails the D1
 * batch, while an exact one-row transition stays on the success branch.
 */
export function assertPreviousStatementChangedOne(label: string): StatementPlan {
  return {
    sql: `SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('', '$') END /* ${label} */`,
    params: []
  }
}

/** Fails the batch unless `guard` holds after the preceding statements (same mechanism). */
export function assertGuard(label: string, guard: PlanGuard): StatementPlan {
  return {
    sql: `SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE json_extract('', '$') END /* ${label} */`,
    params: guard.params
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

/**
 * The ISO instant `hours` before `now`. Plans compare stored ISO instants as text, so `now` must
 * be `Date#toISOString()` output.
 */
export function hoursBefore(now: string, hours: number): string {
  const time = ISO_INSTANT.test(now) ? Date.parse(now) : Number.NaN
  if (Number.isNaN(time)) throw new Error('Plans need an ISO instant (toISOString()).')
  return new Date(time - hours * 60 * 60 * 1000).toISOString()
}

/**
 * True while a listing's own submission is still in review with its listing live
 * (`paid_pending_review` or `changes_requested`): the submission is then the listing's only
 * staged-edit channel, so revisions and unpublishing wait for its decision.
 */
export function listingHasQueuedSubmission(listingIdSql: string): string {
  return `EXISTS (SELECT 1 FROM listing_submissions queued WHERE queued.listing_id=${listingIdSql}
    AND queued.status IN ('paid_pending_review','changes_requested'))`
}

/** A listing that anonymous visitors can see (the catalog's public eligibility, minus time). */
export function listingIsLiveGuard(listingIdSql: string): string {
  return `EXISTS (SELECT 1 FROM listings live WHERE live.id=${listingIdSql}
    AND live.status='approved' AND live.is_active=1 AND live.published_at IS NOT NULL)`
}

/**
 * True while the listing is filed under a retired category (`categories.is_active = 0`), primary
 * or not (#260). Retiring a category takes its listings off the domain: such a listing answers
 * 404, and nothing makes it live again (`0011_retired_categories` refuses it in D1 too).
 */
export function listingInRetiredCategory(listingIdSql: string): string {
  return `EXISTS (SELECT 1 FROM listing_categories retired_lc
    JOIN categories retired_c ON retired_c.id = retired_lc.category_id
    WHERE retired_lc.listing_id = ${listingIdSql} AND retired_c.is_active = 0)`
}

/**
 * Audit and compare-and-swap inputs for a write that changes public catalog output. Public
 * pages and the data cache are keyed by the catalog epoch (`publication_state.version` plus
 * the newest public `published_at`), so such a write advances the version in the same batch
 * and records a `publication_runs` row.
 */
export interface CatalogPublication {
  actor: string
  affectedRoutes: string
  afterChecksum: string
  beforeChecksum: string
  manifestId: string
  now: string
  runId: string
  version: number
  workflow: string
}

/**
 * Builds the publication inputs for one catalog write from the current publication state.
 * The manifest and run ids carry the next version, so they are unique per publication, and
 * the next checksum chains from the current one.
 */
export async function prepareCatalogPublication(input: {
  action: string
  actor: string
  affectedRoutes: string
  checksum: string
  entityId: string
  now: string
  version: number
  workflow: string
}): Promise<CatalogPublication> {
  if (!Number.isSafeInteger(input.version) || input.version < 0) {
    throw new Error('Catalog publication version must be a non-negative integer.')
  }
  const nextVersion = input.version + 1
  const manifestId = `${input.action}-${input.entityId}-v${nextVersion}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${input.checksum}\n${manifestId}\n${nextVersion}`)
  )
  return {
    actor: input.actor,
    affectedRoutes: input.affectedRoutes,
    afterChecksum: Array.from(new Uint8Array(digest), byte =>
      byte.toString(16).padStart(2, '0')
    ).join(''),
    beforeChecksum: input.checksum,
    manifestId,
    now: input.now,
    runId: `${input.action}_${input.entityId}_v${nextVersion}`,
    version: input.version,
    workflow: input.workflow
  }
}

/**
 * Opens the publication: records a started run only while `guard` holds and the publication
 * state is still the one the caller read.
 */
export function beginCatalogPublicationPlans(
  publication: CatalogPublication,
  guard: PlanGuard,
  label = 'publication_snapshot_current'
): StatementPlan[] {
  return [
    {
      sql: `INSERT INTO publication_runs
        (id,manifest_id,base_version,input_checksum,affected_records,affected_routes,outcome,
         started_at,actor,workflow,before_checksum,after_checksum)
        SELECT ?,?,?,?,1,?,'started',?,?,?,?,?
        WHERE (${guard.sql})
          AND EXISTS (SELECT 1 FROM publication_state WHERE id=1 AND version=? AND checksum=?)`,
      params: [
        publication.runId,
        publication.manifestId,
        publication.version,
        publication.afterChecksum,
        publication.affectedRoutes,
        publication.now,
        publication.actor,
        publication.workflow,
        publication.beforeChecksum,
        publication.afterChecksum,
        ...guard.params,
        publication.version,
        publication.beforeChecksum
      ]
    },
    assertPreviousStatementChangedOne(label)
  ]
}

/** Advances the catalog version and completes the run opened by the begin plan. */
export function finishCatalogPublicationPlans(publication: CatalogPublication): StatementPlan[] {
  return [
    {
      sql: `UPDATE publication_state SET version=version+1,manifest_id=?,checksum=?,published_at=?
        WHERE id=1 AND version=? AND checksum=?`,
      params: [
        publication.manifestId,
        publication.afterChecksum,
        publication.now,
        publication.version,
        publication.beforeChecksum
      ]
    },
    assertPreviousStatementChangedOne('publication_state_advanced'),
    {
      sql: `UPDATE publication_runs SET outcome='succeeded',published_version=?,completed_at=?
        WHERE id=? AND outcome='started'`,
      params: [publication.version + 1, publication.now, publication.runId]
    },
    assertPreviousStatementChangedOne('publication_audit_completed')
  ]
}

/** The hosted-image columns of `listing_media` and `media_ingestions` (#95). */
export const HOSTED_MEDIA_COLUMNS = 'media_key,sha256,content_type,bytes,width,height'
/** Clears a `media_ingestions` slot's hosted result. */
export const CLEARED_MEDIA_RESULT = `media_key=NULL,sha256=NULL,content_type=NULL,bytes=NULL,
  width=NULL,height=NULL`

/**
 * A submission's or a revision's reviewed hosted copy for a listing slot: queued with
 * `copy_from_key`, so the cron copies it into the listing's path
 * (`best.serp.co/listings/<slug>/…`). Runs inside an approval batch.
 */
function queueFromStagedSlot(input: {
  kind: 'image' | 'logo'
  listingId: string
  now: string
  /** Extra condition on the staged slot `j` (SQL, with `params`). */
  slotCondition: { params: unknown[]; sql: string }
  stagedId: string
  stagedTable: 'listing_revisions' | 'listing_submissions'
}): StatementPlan {
  const column = input.stagedTable === 'listing_submissions' ? 'submission_id' : 'revision_id'
  return {
    sql: `INSERT INTO media_ingestions
      (listing_id,kind,sort_order,source_url,copy_from_key,status,attempts,next_attempt_at,
       created_at,updated_at)
      SELECT ?,j.kind,0,j.source_url,CASE WHEN j.status='hosted' THEN j.media_key END,'pending',
        0,?,?,?
      FROM media_ingestions j
      WHERE j.${column}=? AND j.kind=? AND j.sort_order=0 AND j.status IN ('hosted','pending')
        AND (${input.slotCondition.sql})
      ON CONFLICT(listing_id,kind,sort_order) WHERE listing_id IS NOT NULL DO UPDATE SET
        source_url=excluded.source_url,copy_from_key=excluded.copy_from_key,status='pending',
        attempts=0,next_attempt_at=excluded.next_attempt_at,last_error=NULL,
        ${CLEARED_MEDIA_RESULT},updated_at=excluded.updated_at`,
    params: [
      input.listingId,
      input.now,
      input.now,
      input.now,
      input.stagedId,
      input.kind,
      ...input.slotCondition.params
    ]
  }
}

/**
 * The hosted logo a review screen shows for a staged logo (#96 round 2 S9, round 4): the
 * submission's or the revision's own hosted copy of its `logo_url` (hosted when it was saved),
 * or for a revision that kept the listing's logo, the listing's hosted copy of that source.
 * Only `?` binds the staged id.
 */
export function stagedLogoKeySql(stagedTable: 'listing_revisions' | 'listing_submissions'): string {
  return stagedTable === 'listing_submissions'
    ? `(SELECT j.media_key FROM media_ingestions j JOIN listing_submissions s ON s.id=j.submission_id
        WHERE s.id=? AND j.kind='logo' AND j.sort_order=0 AND j.status='hosted'
          AND j.source_url=s.logo_url)`
    : `(SELECT COALESCE(
          (SELECT j.media_key FROM media_ingestions j WHERE j.revision_id=r.id AND j.kind='logo'
            AND j.sort_order=0 AND j.status='hosted' AND j.source_url=r.logo_url),
          (SELECT m.media_key FROM listing_media m WHERE m.listing_id=r.listing_id
            AND m.kind='logo' AND m.media_key IS NOT NULL AND m.url=r.logo_url
            ORDER BY m.sort_order LIMIT 1))
        FROM listing_revisions r WHERE r.id=?)`
}

/** The `<hash>.<ext>` a logo key ends with: the same bytes under any owner's path. */
const logoTail = (key: string) => `substr(${key}, instr(${key}, '/logo/') + 6)`

/**
 * Gives a listing the logo staged on a submission or revision, only as it was reviewed (#96
 * review round 3, S1); never a hotlink, and never a later fetch of the staged URL:
 * - `reviewedKey` is the hosted logo the review screen showed (null when it showed none). The
 *   batch is refused unless that is still the staged logo's hosted copy (a compare-and-swap).
 *   Without it (a paid listing going live at payment, the legacy approval workflow) the staged
 *   logo's current hosted copy is used, unreviewed but never refetched.
 * - With no hosted logo to adopt, the listing keeps its current logo (row and queue) untouched
 *   (#96 review round 4, S1): an approval never deletes a logo it cannot replace.
 * - The listing's logo row stays when its source is the staged logo and it holds those bytes, or
 *   is an imported row not hosted yet (#95 review S7: relative and repo paths survive).
 * - Otherwise the reviewed copy (the submission's or the revision's) is queued to be copied into
 *   the listing's path.
 */
export function adoptStagedLogoPlans(input: {
  listingId: string
  now: string
  reviewedKey?: string | null
  stagedId: string
  stagedTable: 'listing_revisions' | 'listing_submissions'
}): StatementPlan[] {
  hoursBefore(input.now, 0)
  const { listingId, stagedId, stagedTable } = input
  const stagedLogo = `(SELECT logo_url FROM ${stagedTable} WHERE id=?)`
  const logoRow = `EXISTS (SELECT 1 FROM listing_media WHERE listing_id=? AND kind='logo')`
  const reviewed = input.reviewedKey !== undefined
  // The key to adopt: the reviewed one, or (unreviewed) the staged logo's hosted copy now.
  const adopt = reviewed
    ? { sql: '?', params: [input.reviewedKey] }
    : { sql: stagedLogoKeySql(stagedTable), params: [stagedId] }
  return [
    ...(reviewed
      ? [
          assertGuard('reviewed_logo_current', {
            sql: `${stagedLogoKeySql(stagedTable)} IS ?`,
            params: [stagedId, input.reviewedKey]
          })
        ]
      : []),
    {
      sql: `DELETE FROM listing_media WHERE listing_id=? AND kind='logo'
        AND ${adopt.sql} IS NOT NULL
        AND NOT (url IS ${stagedLogo} AND (media_key IS NULL
          OR ${logoTail('media_key')} IS ${logoTail(adopt.sql)}))`,
      params: [listingId, ...adopt.params, stagedId, ...adopt.params, ...adopt.params]
    },
    {
      sql: `DELETE FROM media_ingestions WHERE listing_id=? AND kind='logo'
        AND ${adopt.sql} IS NOT NULL`,
      params: [listingId, ...adopt.params]
    },
    queueFromStagedSlot({
      kind: 'logo',
      listingId,
      now: input.now,
      slotCondition: {
        sql: `j.status='hosted' AND j.media_key=${adopt.sql} AND NOT ${logoRow}`,
        params: [...adopt.params, listingId]
      },
      stagedId,
      stagedTable
    })
  ]
}

/**
 * Gives a listing the submission's featured image only as the reviewer saw it (#96 review
 * round 2, B1): `reviewedKey` is the hosted image key the review screen showed, or null when it
 * showed none. The batch is refused unless that is still the submission's hosted image (a
 * compare-and-swap, like `content_version`), and only that key is queued for a copy into the
 * listing's path. A pending or failed image the reviewer could not see is never adopted.
 */
export function adoptSubmissionImagePlans(input: {
  listingId: string
  now: string
  reviewedKey: string | null
  submissionId: string
}): StatementPlan[] {
  hoursBefore(input.now, 0)
  const hostedImage = `(SELECT media_key FROM media_ingestions WHERE submission_id=?
    AND kind='image' AND sort_order=0 AND status='hosted')`
  return [
    assertGuard('reviewed_image_current', {
      sql: `${hostedImage} IS ?`,
      params: [input.submissionId, input.reviewedKey]
    }),
    ...(input.reviewedKey
      ? [
          queueFromStagedSlot({
            kind: 'image',
            listingId: input.listingId,
            now: input.now,
            slotCondition: {
              sql: `j.status='hosted' AND j.media_key=?`,
              params: [input.reviewedKey]
            },
            stagedId: input.submissionId,
            stagedTable: 'listing_submissions'
          })
        ]
      : [])
  ]
}

/** Staged listing content shared by submissions and revisions. */
export interface StagedListingContent {
  categorySlug: string
  content: string | null
  description: string
  faqs: Array<{ answer: string; question: string }>
  logoUrl: string
  name: string
  resourceLinks: Array<{ label: string; url: string }>
  videoUrl?: string | null
}

export interface StagedContentSource {
  faqTable: 'listing_revision_faqs' | 'listing_submission_faqs'
  id: string
  /** Foreign key column of the resource-link and FAQ tables. */
  parentColumn: 'revision_id' | 'submission_id'
  resourceTable: 'listing_revision_resource_links' | 'listing_submission_resource_links'
  table: 'listing_revisions' | 'listing_submissions'
}

export function submissionContentSource(id: string): StagedContentSource {
  return {
    faqTable: 'listing_submission_faqs',
    id,
    parentColumn: 'submission_id',
    resourceTable: 'listing_submission_resource_links',
    table: 'listing_submissions'
  }
}

export function revisionContentSource(id: string): StagedContentSource {
  return {
    faqTable: 'listing_revision_faqs',
    id,
    parentColumn: 'revision_id',
    resourceTable: 'listing_revision_resource_links',
    table: 'listing_revisions'
  }
}

/**
 * Resource links and FAQs per submission or revision: the submission form's caps
 * (`apps/web/src/lib/submissions/contract.ts`), enforced here as well so a batch's
 * statement count stays bounded whatever the caller (#77).
 */
export const MAX_STAGED_RESOURCE_LINKS = 5
export const MAX_STAGED_FAQS = 5

/** Throws when staged content has more resource links or FAQs than a listing may carry. */
export function assertStagedChildLimits(
  content: Pick<StagedListingContent, 'faqs' | 'resourceLinks'>
): void {
  if (content.resourceLinks.length > MAX_STAGED_RESOURCE_LINKS) {
    throw new Error(`A listing has at most ${MAX_STAGED_RESOURCE_LINKS} resource links.`)
  }
  if (content.faqs.length > MAX_STAGED_FAQS) {
    throw new Error(`A listing has at most ${MAX_STAGED_FAQS} FAQs.`)
  }
}

/**
 * Replaces the resource links and FAQs of a staged submission or revision. The caller's
 * preceding compare-and-swap decides whether the row may be edited.
 */
export function replaceStagedChildrenPlans(
  source: StagedContentSource,
  content: Pick<StagedListingContent, 'faqs' | 'resourceLinks'>
): StatementPlan[] {
  assertStagedChildLimits(content)
  return [
    {
      sql: `DELETE FROM ${source.resourceTable} WHERE ${source.parentColumn}=?`,
      params: [source.id]
    },
    ...content.resourceLinks.map((link, index) => ({
      sql: `INSERT INTO ${source.resourceTable} (${source.parentColumn},label,url,sort_order)
        VALUES (?,?,?,?)`,
      params: [source.id, link.label, link.url, index]
    })),
    { sql: `DELETE FROM ${source.faqTable} WHERE ${source.parentColumn}=?`, params: [source.id] },
    ...content.faqs.map((faq, index) => ({
      sql: `INSERT INTO ${source.faqTable} (${source.parentColumn},question,answer,sort_order)
        VALUES (?,?,?,?)`,
      params: [source.id, faq.question, faq.answer, index]
    }))
  ]
}

/**
 * Applies staged content to a live listing inside the batch. The listing is moved to `draft`
 * first so the primary-category triggers allow its memberships to change, then published again
 * (the triggers re-check exactly one primary category). Website, slug, publication time,
 * featured state, images, and secondary categories are kept; the primary category, name,
 * description, content, logo, video, resource links, and FAQs are replaced.
 */
export function applyStagedContentPlans(input: {
  checksum: string
  listingId: string
  now: string
  /** The hosted logo the reviewer saw (null for the tile); see `adoptStagedLogoPlans`. */
  reviewedLogoKey?: string | null
  source: StagedContentSource
}): StatementPlan[] {
  const { listingId, source } = input
  const stagedCategory = `(SELECT c.id FROM ${source.table} staged
    JOIN categories c ON c.slug=staged.category_slug AND c.is_active=1 WHERE staged.id=?)`
  return [
    {
      sql: `UPDATE listings SET status='draft'
        WHERE id=? AND status='approved' AND is_active=1 AND published_at IS NOT NULL`,
      params: [listingId]
    },
    assertPreviousStatementChangedOne('listing_opened_for_staged_content'),
    {
      sql: `UPDATE listings SET (name,description,content) =
          (SELECT name,description,content FROM ${source.table} WHERE id=?),
          checksum=?,updated_at=?
        WHERE id=? AND status='draft'`,
      params: [source.id, input.checksum, input.now, listingId]
    },
    assertPreviousStatementChangedOne('listing_fields_replaced'),
    {
      sql: `DELETE FROM listing_categories
        WHERE listing_id=? AND is_primary=1 AND category_id IS NOT ${stagedCategory}`,
      params: [listingId, source.id]
    },
    {
      sql: `INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary)
        SELECT ?,c.id,0,1 FROM ${source.table} staged
        JOIN categories c ON c.slug=staged.category_slug AND c.is_active=1
        WHERE staged.id=?
        ON CONFLICT(listing_id,category_id) DO UPDATE SET is_primary=1,sort_order=0`,
      params: [listingId, source.id]
    },
    assertPreviousStatementChangedOne('primary_category_replaced'),
    { sql: `DELETE FROM listing_media WHERE listing_id=? AND kind='video'`, params: [listingId] },
    // Never a hotlink (#95), and only the reviewed logo (#96 round 3).
    ...adoptStagedLogoPlans({
      listingId,
      now: input.now,
      reviewedKey: input.reviewedLogoKey,
      stagedId: source.id,
      stagedTable: source.table
    }),
    {
      sql: `INSERT INTO listing_media (listing_id,kind,url,sort_order)
        SELECT ?,'video',video_url,1 FROM ${source.table} WHERE id=? AND video_url IS NOT NULL`,
      params: [listingId, source.id]
    },
    { sql: 'DELETE FROM listing_resource_links WHERE listing_id=?', params: [listingId] },
    {
      sql: `INSERT INTO listing_resource_links (listing_id,label,url,sort_order)
        SELECT ?,label,url,sort_order FROM ${source.resourceTable}
        WHERE ${source.parentColumn}=? ORDER BY sort_order`,
      params: [listingId, source.id]
    },
    { sql: 'DELETE FROM listing_faqs WHERE listing_id=?', params: [listingId] },
    {
      sql: `INSERT INTO listing_faqs (listing_id,question,answer,sort_order)
        SELECT ?,question,answer,sort_order FROM ${source.faqTable}
        WHERE ${source.parentColumn}=? ORDER BY sort_order`,
      params: [listingId, source.id]
    },
    {
      sql: `UPDATE listings SET status='approved' WHERE id=? AND status='draft'`,
      params: [listingId]
    },
    assertPreviousStatementChangedOne('listing_republished_with_staged_content')
  ]
}
