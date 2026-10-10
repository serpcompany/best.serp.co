import { MAX_SUGGESTED_TAGS } from './schema'

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
  /**
   * The Creator's suggested tags (#341), stored as `tag_slugs`: null for "not given" (a
   * revision then leaves the listing's tags as they are). Omitted, the stored value is kept.
   */
  tagSlugs?: readonly string[] | null
  videoUrl?: string | null
}

/** `tag_slugs` as stored: a JSON array of tag slugs, or null (not given). */
export function tagSlugsJson(tags: readonly string[] | null): string | null {
  if (tags === null) return null
  if (new Set(tags).size !== tags.length || tags.some(tag => !tag.trim())) {
    throw new Error('Suggested tags are distinct, non-empty slugs.')
  }
  if (tags.length > MAX_SUGGESTED_TAGS) {
    throw new Error(`A Creator suggests at most ${MAX_SUGGESTED_TAGS} tags.`)
  }
  return JSON.stringify(tags)
}

/** A stored `tag_slugs` (a JSON array, or null) as a list, or null. */
export function parseTagSlugs(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.map(slug => String(slug)) : null
}

/**
 * The stale-slug resolver (#341, design 4.4): what a staged row's `category_slug` (`slugSql`, a
 * column reference with no bindings) files its listing under, for a draft, submission, or
 * revision saved before its narrow category retired. In order:
 * 1. an active category with that slug: that category, and no tag;
 * 2. else the active tag with that slug (an old category kept as a tag): its hub, and the tag;
 * 3. else the old category's `taxonomy_redirects` row (one of the 36 merged into a tag with
 *    another slug, such as `ai-copywriting-free`): a `tag` target, or a `best` target's tag, with
 *    its hub, and that tag; else a `category` target, or a `best` target's category, and no tag.
 * Tags and hubs must be active. Approval, payment, and revision approval use it, so an in-flight
 * row naming a retired narrow slug still goes live; new saves still require an active category.
 */
export function resolveStagedCategorySql(slugSql: string): { categoryId: string; tagId: string } {
  const active = `SELECT c.id FROM categories c WHERE c.slug=${slugSql} AND c.is_active=1`
  const hub = 'JOIN categories hub ON hub.id=t.category_id AND hub.is_active=1'
  const redirect = `FROM taxonomy_redirects r LEFT JOIN best_pages b ON b.id=r.target_best_page_id
    WHERE r.source_kind='category' AND r.source_slug=${slugSql}`
  const sameSlugTag = `SELECT t.id FROM tags t ${hub} WHERE t.slug=${slugSql} AND t.is_active=1`
  const redirectTag = `SELECT t.id FROM tags t ${hub} WHERE t.is_active=1
    AND t.id=(SELECT COALESCE(r.target_tag_id,b.tag_id) ${redirect})`
  const redirectCategory = `SELECT c.id FROM categories c WHERE c.is_active=1
    AND c.id=(SELECT COALESCE(r.target_category_id,b.category_id) ${redirect})`
  const tag = `COALESCE((${sameSlugTag}),(${redirectTag}))`
  return {
    categoryId: `COALESCE((${active}),(SELECT t.category_id FROM tags t WHERE t.id=${tag}),
      (${redirectCategory}))`,
    tagId: `(SELECT ${tag} WHERE NOT EXISTS (${active}))`
  }
}

/**
 * A staged row's tags on its listing (#341, design 4.4), for a new listing (approval or payment)
 * and a revision approval. When the row's `tag_slugs` is set, the listing's tags are replaced by
 * the tag the stale-slug resolver found, then `tag_slugs` in order; when it is null (not given),
 * the listing keeps its tags and only a resolver tag it lacks is appended after them. Each is
 * joined to an active tag, so a retired or unknown one is dropped, and numbered densely from the
 * next free `sort_order` (0 on a new or replaced set), as the admin edit and the publisher's
 * `listing-tags-set` number them: best pages rank by it. Inserts are plain
 * `INSERT … SELECT … WHERE NOT EXISTS`, never an upsert, whose attempted insert would fire
 * `listing_tags_refuse_retired_tag` on a retired tag the listing keeps (docs/data-model.md).
 */
export function stagedTagsPlans(input: {
  listingId: string
  stagedId: string
  stagedTable: 'listing_revisions' | 'listing_submissions'
}): StatementPlan[] {
  const { listingId, stagedId, stagedTable } = input
  const resolved = resolveStagedCategorySql('staged.category_slug')
  return [
    {
      sql: `DELETE FROM listing_tags WHERE listing_id=?
        AND EXISTS (SELECT 1 FROM ${stagedTable} WHERE id=? AND tag_slugs IS NOT NULL)`,
      params: [listingId, stagedId]
    },
    // The SELECT reads listing_tags, so SQLite runs it whole before inserting: the next free
    // sort_order is the one before this insert.
    {
      sql: `INSERT INTO listing_tags (listing_id,tag_id,sort_order)
        SELECT ?,picked.tag_id,
          COALESCE((SELECT MAX(x.sort_order)+1 FROM listing_tags x WHERE x.listing_id=?),0)
            + ROW_NUMBER() OVER (ORDER BY picked.position) - 1
        FROM (
          SELECT tag_id,MIN(position) AS position FROM (
            SELECT ${resolved.tagId} AS tag_id,-1 AS position FROM ${stagedTable} staged
              WHERE staged.id=?
            UNION ALL
            SELECT t.id,j.key FROM ${stagedTable} staged, json_each(staged.tag_slugs) j
              JOIN tags t ON t.slug=j.value AND t.is_active=1
              WHERE staged.id=? AND staged.tag_slugs IS NOT NULL
          ) WHERE tag_id IS NOT NULL GROUP BY tag_id
        ) picked
        WHERE NOT EXISTS (SELECT 1 FROM listing_tags x
          WHERE x.listing_id=? AND x.tag_id=picked.tag_id)`,
      params: [listingId, listingId, stagedId, stagedId, listingId]
    }
  ]
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
 * description, content, logo, video, resource links, and FAQs are replaced. The primary
 * category goes through the stale-slug resolver (`resolveStagedCategorySql`). With `tags` (a
 * revision), the tags are written as `stagedTagsPlans` says; without (a paid listing's live
 * approval), they are left alone: payment already gave the listing the submission's tags, and an
 * admin may have changed them since, which approval must not undo (design 4.3).
 */
export function applyStagedContentPlans(input: {
  checksum: string
  listingId: string
  now: string
  /** The hosted logo the reviewer saw (null for the tile); see `adoptStagedLogoPlans`. */
  reviewedLogoKey?: string | null
  source: StagedContentSource
  /** Write the staged row's tags (a revision), or leave the listing's (a live submission). */
  tags: boolean
}): StatementPlan[] {
  const { listingId, source } = input
  const resolved = resolveStagedCategorySql('staged.category_slug')
  const stagedCategory = `(SELECT ${resolved.categoryId} FROM ${source.table} staged
    WHERE staged.id=?)`
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
        SELECT ?,${resolved.categoryId},0,1 FROM ${source.table} staged
        WHERE staged.id=? AND ${resolved.categoryId} IS NOT NULL
        ON CONFLICT(listing_id,category_id) DO UPDATE SET is_primary=1,sort_order=0`,
      params: [listingId, source.id]
    },
    assertPreviousStatementChangedOne('primary_category_replaced'),
    ...(input.tags
      ? stagedTagsPlans({ listingId, stagedId: source.id, stagedTable: source.table })
      : []),
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
