/**
 * The admin's taxonomy decisions (serpcompany/best.serp.co#405): create, edit, rename, and retire
 * categories (hubs), tags, and best pages, and set a best page's pins, behind the admin gate, the
 * allowlist, and the `Origin` check (the production-write exception, docs/admin-panel.md). This
 * replaces #341's design default 12 ("hubs, tags, and best pages through manifests only") by the
 * owner's decision.
 *
 * Each decision reads the item and the publication state (`selectTaxonomyStatePlan`), answers a
 * replay as a no-op, refuses what the publisher's guards would refuse with a message the admin
 * can act on, and sends `buildTaxonomyPlans`: the publisher's own operations from
 * `@/db/taxonomy-plans`, with their `expected` guards, between a publication that advances the
 * catalog version (so cached pages turn over) and records the run under the admin's email. A
 * rename keeps the row, so its listings, pins, and the redirects aimed at it follow, and its old
 * URL answers a 308 to the new one; a retirement sends its URL to the page the admin chose.
 */
import { createAdminReadOperations } from '@/db/admin-queries'
import { queryPlan } from '@/db/plan-runner'
import { prepareCatalogPublication } from '@/db/plan-support'
import { BEST_PAGE_LIST_SIZE } from '@/db/schema'
import {
  type BestPageState,
  buildTaxonomyPlans,
  type ListingRef,
  sameTarget,
  selectTaxonomyStatePlan,
  type TaxonomyKind,
  type TaxonomyOperation,
  type TaxonomyTarget
} from '@/db/taxonomy-plans'
import { getRoute } from '@/lib/routing/routes'
import {
  type AdminContext,
  changed,
  commit,
  type Decision,
  type DecisionFailure,
  failure,
  log,
  notFound,
  nowIso,
  retryPublicationRace,
  WORKFLOW
} from './decisions'
import { isFeatureListing } from './feature-listings'
import { isTaxonomySlug, TAXONOMY_LIMITS } from './taxonomy-fields'

/** One row of `selectTaxonomyStatePlan`. */
interface StateRow {
  item: string | null
  publication_checksum: string
  redirect: string | null
  version: number
}

interface CategoryItem {
  active: number
  activeBestPages: number
  activeTags: number
  description: string
  liveListings: number
  name: string
  order: number
  redirectSources: number
  slug: string
}

interface TagItem {
  active: number
  activeBestPages: number
  category: string
  description: string
  name: string
  order: number
  slug: string
}

interface BestPageItem extends BestPageState {
  active: number
  exclude: Array<[string, string]>
  pins: Array<[string, string, string | null]>
  slug: string
}

/** A category's form fields. */
export interface CategoryFields {
  description: string
  name: string
  order: number
  slug: string
}

/** A tag's form fields; `category` is its hub's slug. */
export interface TagFields {
  category: string
  description: string
  name: string
  slug: string
}

/** A best page's form fields; `tag` is the slug of the tag it ranks. */
export interface BestPageFields {
  intro: string
  keyword: string
  slug: string
  tag: string
  title: string
}

const replay = <T extends object>(result: T): Decision<T> => ({
  ok: true,
  replayed: true,
  ...result
})

const slugTaken = failure(422, 'slug_taken', 'That slug is taken.')
const slugInvalid = failure(
  422,
  'invalid_slug',
  `Use up to ${TAXONOMY_LIMITS.slug} lowercase letters, numbers and hyphens for the slug.`
)
const redirectsElsewhere = failure(
  422,
  'slug_redirects',
  'That URL already redirects elsewhere. Choose another slug.'
)
const invalidRedirect = failure(422, 'invalid_redirect', 'Choose an active page to redirect to.')

async function readState(
  context: AdminContext,
  kind: TaxonomyKind,
  slug: string
): Promise<StateRow> {
  const [row] = await queryPlan<StateRow>(context.client, selectTaxonomyStatePlan(kind, slug))
  if (!row) throw new Error('The publication state is missing.')
  return row
}

const itemOf = <T>(read: StateRow): T | null => (read.item ? (JSON.parse(read.item) as T) : null)

/** Where the item's URL redirects, if anywhere. */
function redirectOf(read: StateRow): TaxonomyTarget | null {
  if (!read.redirect) return null
  const [kind, slug] = JSON.parse(read.redirect) as [string, string | null]
  return kind === 'directory' ? { kind } : { kind: kind as TaxonomyKind, slug: slug ?? '' }
}

function pageRoute(kind: TaxonomyKind, slug: string): string {
  if (kind === 'category') return getRoute('category.page', { category: slug })
  return kind === 'tag'
    ? getRoute('tag.page', { tag: slug })
    : getRoute('best.page', { keyword: slug })
}

function indexRoute(kind: TaxonomyKind): string {
  if (kind === 'category') return getRoute('category.index')
  return kind === 'tag' ? getRoute('tag.index') : getRoute('best.index')
}

function targetRoute(target: TaxonomyTarget): string {
  return target.kind === 'directory'
    ? getRoute('listing.list')
    : pageRoute(target.kind, target.slug)
}

/**
 * Sends the operations as one batch on the state the admin read. A refusal re-reads: a decision
 * that already holds is a replay, one that lost only the race for the publication version runs
 * again (`retryPublicationRace`), anything else is 409.
 */
async function publish<T extends object>(input: {
  action: string
  context: AdminContext
  kind: TaxonomyKind
  operations: TaxonomyOperation[]
  read: StateRow
  result: T
  routes: string[]
  settled: () => Promise<boolean>
  slug: string
}): Promise<Decision<T>> {
  const { context, kind, read, slug } = input
  const publication = await prepareCatalogPublication({
    action: input.action,
    actor: context.actor,
    affectedRoutes: [...new Set(input.routes)].sort().join('\n'),
    checksum: read.publication_checksum,
    entityId: slug,
    now: nowIso(context),
    version: read.version,
    workflow: WORKFLOW
  })
  return commit(
    context,
    buildTaxonomyPlans({ operations: input.operations, publication }),
    input.settled,
    input.result,
    {
      global: ['version', 'publication_checksum'],
      read: () => readState(context, kind, slug),
      snapshot: read
    }
  )
}

function textProblem(
  value: string,
  max: number,
  label: string,
  required = true
): DecisionFailure | null {
  if (required && !value) return failure(422, 'invalid_field', `Enter ${label}.`)
  if (value.length > max) {
    return failure(422, 'invalid_field', `Keep ${label} to ${max} characters.`)
  }
  return null
}

/**
 * Why a page can't take `slug`: a category, tag, or best page of the kind has it, active or
 * retired, or its URL already redirects elsewhere. A redirect to the page itself, left by an
 * earlier rename away from the slug, is no obstacle: the rename removes it.
 */
async function slugUnavailable(
  context: AdminContext,
  kind: TaxonomyKind,
  slug: string,
  current: string | null
): Promise<DecisionFailure | null> {
  const read = await readState(context, kind, slug)
  if (read.item) return slugTaken
  const redirect = redirectOf(read)
  if (redirect && !(current !== null && sameTarget(redirect, { kind, slug: current }))) {
    return redirectsElsewhere
  }
  return null
}

/**
 * Why a retiring page can't redirect to `target`: it isn't an active category, tag, or best page
 * (or the directory), it is the page itself, or its own URL redirects elsewhere, which would be a
 * second hop (the publisher's chain guard).
 */
async function redirectProblem(
  context: AdminContext,
  target: TaxonomyTarget,
  self: { kind: TaxonomyKind; slug: string }
): Promise<DecisionFailure | null> {
  if (target.kind === 'directory') return null
  if (sameTarget(target, self)) return invalidRedirect
  const read = await readState(context, target.kind, target.slug)
  if (itemOf<{ active: number }>(read)?.active !== 1) return invalidRedirect
  const redirect = redirectOf(read)
  if (redirect && !sameTarget(redirect, self)) {
    return failure(422, 'redirect_chain', 'That page’s URL redirects elsewhere. Choose another.')
  }
  return null
}

/** A retirement, once its refusals passed: the item retires and its URL redirects to `target`. */
async function retire<T extends object>(input: {
  context: AdminContext
  kind: TaxonomyKind
  operation: TaxonomyOperation
  read: StateRow
  result: T
  slug: string
  target: TaxonomyTarget
}): Promise<Decision<T>> {
  const { context, kind, slug, target } = input
  const problem = await redirectProblem(context, target, { kind, slug })
  if (problem) return problem
  return publish({
    action: `${kind === 'best' ? 'best-page' : kind}-retire`,
    context,
    kind,
    operations: [input.operation],
    read: input.read,
    result: input.result,
    routes: [pageRoute(kind, slug), indexRoute(kind), targetRoute(target)],
    settled: async () => {
      const after = await readState(context, kind, slug)
      const item = itemOf<{ active: number }>(after)
      return item?.active === 0 && sameTarget(redirectOf(after), target)
    },
    slug
  })
}

/** A retired item whose URL already redirects to `target` is a replay; otherwise 409. */
function retiredAlready<T extends object>(
  read: StateRow,
  target: TaxonomyTarget,
  result: T
): Decision<T> {
  return sameTarget(redirectOf(read), target) ? replay(result) : changed
}

// ---------------------------------------------------------------------------------------------
// Categories (hubs)

function categoryFields(input: CategoryFields): CategoryFields {
  return {
    description: input.description.trim(),
    name: input.name.trim(),
    order: input.order,
    slug: input.slug.trim()
  }
}

function categoryProblem(fields: CategoryFields, checkSlug: boolean): DecisionFailure | null {
  if (checkSlug && !isTaxonomySlug(fields.slug)) return slugInvalid
  const order =
    Number.isInteger(fields.order) && fields.order >= 0 && fields.order <= TAXONOMY_LIMITS.order
      ? null
      : failure(422, 'invalid_field', `Enter an order from 0 to ${TAXONOMY_LIMITS.order}.`)
  return (
    textProblem(fields.name, TAXONOMY_LIMITS.name, 'a name') ??
    textProblem(fields.description, TAXONOMY_LIMITS.description, 'the description', false) ??
    order
  )
}

const sameCategory = (item: CategoryItem, fields: CategoryFields) =>
  item.slug === fields.slug &&
  item.name === fields.name &&
  item.description === fields.description &&
  item.order === fields.order

/** A category with exactly these fields is active now. */
async function categoryHolds(context: AdminContext, fields: CategoryFields): Promise<boolean> {
  const item = itemOf<CategoryItem>(await readState(context, 'category', fields.slug))
  return item?.active === 1 && sameCategory(item, fields)
}

export function createCategory(
  context: AdminContext,
  input: CategoryFields
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => createCategoryOnce(context, input))
}

async function createCategoryOnce(
  context: AdminContext,
  input: CategoryFields
): Promise<Decision<{ slug: string }>> {
  const fields = categoryFields(input)
  const problem = categoryProblem(fields, true)
  if (problem) return problem
  const result = { slug: fields.slug }
  const read = await readState(context, 'category', fields.slug)
  const item = itemOf<CategoryItem>(read)
  if (item) return item.active === 1 && sameCategory(item, fields) ? replay(result) : slugTaken
  if (read.redirect) return redirectsElsewhere
  const decision = await publish({
    action: 'category-create',
    context,
    kind: 'category',
    operations: [{ action: 'category-create', category: fields }],
    read,
    result,
    routes: [pageRoute('category', fields.slug), indexRoute('category')],
    settled: () => categoryHolds(context, fields),
    slug: fields.slug
  })
  log(context, 'create_category', fields.slug, decision.ok ? 'created' : decision.error)
  return decision
}

export function updateCategory(
  context: AdminContext,
  input: Parameters<typeof updateCategoryOnce>[1]
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => updateCategoryOnce(context, input))
}

async function updateCategoryOnce(
  context: AdminContext,
  input: { category: CategoryFields; expected: CategoryFields; slug: string }
): Promise<Decision<{ slug: string }>> {
  const fields = categoryFields(input.category)
  const renamed = fields.slug !== input.slug
  const problem = categoryProblem(fields, renamed)
  if (problem) return problem
  const result = { slug: fields.slug }
  const read = await readState(context, 'category', input.slug)
  const item = itemOf<CategoryItem>(read)
  if (item?.active !== 1) {
    if (renamed && (await categoryHolds(context, fields))) return replay(result)
    return notFound('category')
  }
  if (sameCategory(item, fields)) return replay(result)
  if (!sameCategory(item, categoryFields(input.expected))) return changed
  if (renamed) {
    const unavailable = await slugUnavailable(context, 'category', fields.slug, input.slug)
    if (unavailable) return unavailable
  }
  // The rename goes first, so the edit and the end-of-batch checks find the page by its new slug.
  const operations: TaxonomyOperation[] = renamed
    ? [{ action: 'taxonomy-rename', kind: 'category', slug: input.slug, to: fields.slug }]
    : []
  if (
    item.name !== fields.name ||
    item.description !== fields.description ||
    item.order !== fields.order
  ) {
    operations.push({
      action: 'category-edit',
      category: { description: fields.description, name: fields.name, order: fields.order },
      expected: { description: item.description, name: item.name, order: item.order },
      slug: fields.slug
    })
  }
  const decision = await publish({
    action: 'category-update',
    context,
    kind: 'category',
    operations,
    read,
    result,
    routes: [
      pageRoute('category', input.slug),
      pageRoute('category', fields.slug),
      indexRoute('category')
    ],
    settled: () => categoryHolds(context, fields),
    slug: input.slug
  })
  log(context, 'update_category', input.slug, decision.ok ? fields.slug : decision.error)
  return decision
}

export function retireCategory(
  context: AdminContext,
  input: Parameters<typeof retireCategoryOnce>[1]
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => retireCategoryOnce(context, input))
}

async function retireCategoryOnce(
  context: AdminContext,
  input: { redirect: TaxonomyTarget; slug: string }
): Promise<Decision<{ slug: string }>> {
  const read = await readState(context, 'category', input.slug)
  const item = itemOf<CategoryItem>(read)
  const result = { slug: input.slug }
  if (!item) return notFound('category')
  if (item.active !== 1) return retiredAlready(read, input.redirect, result)
  // The publisher's refusals (`category-unpublish`), and what draws on the category.
  if (item.liveListings > 0) {
    return failure(
      409,
      'category_has_listings',
      'Move its live listings to another category first.'
    )
  }
  if (item.activeTags > 0) {
    return failure(
      409,
      'category_has_tags',
      'Retire its tags or move them to another category first.'
    )
  }
  if (item.activeBestPages > 0) {
    return failure(409, 'category_has_best_pages', 'Retire the best pages that draw on it first.')
  }
  if (item.redirectSources > 0) {
    return failure(
      409,
      'category_redirect_source',
      'A listing filed under it is the source of a slug redirect. Re-file that listing first.'
    )
  }
  const decision = await retire({
    context,
    kind: 'category',
    operation: { action: 'category-retire', redirect: input.redirect, slug: input.slug },
    read,
    result,
    slug: input.slug,
    target: input.redirect
  })
  log(context, 'retire_category', input.slug, decision.ok ? 'retired' : decision.error)
  return decision
}

// ---------------------------------------------------------------------------------------------
// Tags

function tagFields(input: TagFields): TagFields {
  return {
    category: input.category.trim(),
    description: input.description.trim(),
    name: input.name.trim(),
    slug: input.slug.trim()
  }
}

async function tagProblem(
  context: AdminContext,
  fields: TagFields,
  checkSlug: boolean
): Promise<DecisionFailure | null> {
  if (checkSlug && !isTaxonomySlug(fields.slug)) return slugInvalid
  const text =
    textProblem(fields.name, TAXONOMY_LIMITS.name, 'a name') ??
    textProblem(fields.description, TAXONOMY_LIMITS.description, 'the description', false)
  if (text) return text
  const categories = await createAdminReadOperations({
    client: context.client
  }).listActiveCategories()
  return categories.some(category => category.slug === fields.category)
    ? null
    : failure(422, 'invalid_category', 'Choose an active category.')
}

const sameTag = (item: TagItem, fields: TagFields) =>
  item.slug === fields.slug &&
  item.name === fields.name &&
  item.description === fields.description &&
  item.category === fields.category

async function tagHolds(context: AdminContext, fields: TagFields): Promise<boolean> {
  const item = itemOf<TagItem>(await readState(context, 'tag', fields.slug))
  return item?.active === 1 && sameTag(item, fields)
}

export function createTag(
  context: AdminContext,
  input: TagFields
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => createTagOnce(context, input))
}

async function createTagOnce(
  context: AdminContext,
  input: TagFields
): Promise<Decision<{ slug: string }>> {
  const fields = tagFields(input)
  const result = { slug: fields.slug }
  if (!isTaxonomySlug(fields.slug)) return slugInvalid
  const read = await readState(context, 'tag', fields.slug)
  const item = itemOf<TagItem>(read)
  if (item) return item.active === 1 && sameTag(item, fields) ? replay(result) : slugTaken
  const problem = await tagProblem(context, fields, true)
  if (problem) return problem
  if (read.redirect) return redirectsElsewhere
  const decision = await publish({
    action: 'tag-create',
    context,
    kind: 'tag',
    operations: [{ action: 'tag-create', tag: { ...fields, order: 0 } }],
    read,
    result,
    routes: [
      pageRoute('tag', fields.slug),
      indexRoute('tag'),
      pageRoute('category', fields.category)
    ],
    settled: () => tagHolds(context, fields),
    slug: fields.slug
  })
  log(context, 'create_tag', fields.slug, decision.ok ? 'created' : decision.error)
  return decision
}

export function updateTag(
  context: AdminContext,
  input: Parameters<typeof updateTagOnce>[1]
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => updateTagOnce(context, input))
}

async function updateTagOnce(
  context: AdminContext,
  input: { expected: TagFields; slug: string; tag: TagFields }
): Promise<Decision<{ slug: string }>> {
  const fields = tagFields(input.tag)
  const renamed = fields.slug !== input.slug
  if (renamed && !isTaxonomySlug(fields.slug)) return slugInvalid
  const result = { slug: fields.slug }
  const read = await readState(context, 'tag', input.slug)
  const item = itemOf<TagItem>(read)
  if (item?.active !== 1) {
    if (renamed && (await tagHolds(context, fields))) return replay(result)
    return notFound('tag')
  }
  if (sameTag(item, fields)) return replay(result)
  if (!sameTag(item, tagFields(input.expected))) return changed
  const problem = await tagProblem(context, fields, renamed)
  if (problem) return problem
  if (renamed) {
    const unavailable = await slugUnavailable(context, 'tag', fields.slug, input.slug)
    if (unavailable) return unavailable
  }
  // The rename goes first, so the edit finds the tag by its new slug.
  const operations: TaxonomyOperation[] = renamed
    ? [{ action: 'taxonomy-rename', kind: 'tag', slug: input.slug, to: fields.slug }]
    : []
  if (
    item.name !== fields.name ||
    item.description !== fields.description ||
    item.category !== fields.category
  ) {
    operations.push({
      action: 'tag-update',
      expected: { category: item.category, description: item.description, name: item.name },
      slug: fields.slug,
      // The order isn't on the form: it stays as it is.
      tag: {
        category: fields.category,
        description: fields.description,
        name: fields.name,
        order: item.order
      }
    })
  }
  const decision = await publish({
    action: 'tag-update',
    context,
    kind: 'tag',
    operations,
    read,
    result,
    routes: [
      pageRoute('tag', input.slug),
      pageRoute('tag', fields.slug),
      indexRoute('tag'),
      pageRoute('category', item.category),
      pageRoute('category', fields.category)
    ],
    settled: () => tagHolds(context, fields),
    slug: input.slug
  })
  log(context, 'update_tag', input.slug, decision.ok ? fields.slug : decision.error)
  return decision
}

export function retireTag(
  context: AdminContext,
  input: Parameters<typeof retireTagOnce>[1]
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => retireTagOnce(context, input))
}

async function retireTagOnce(
  context: AdminContext,
  input: { redirect: TaxonomyTarget; slug: string }
): Promise<Decision<{ slug: string }>> {
  const read = await readState(context, 'tag', input.slug)
  const item = itemOf<TagItem>(read)
  const result = { slug: input.slug }
  if (!item) return notFound('tag')
  if (item.active !== 1) return retiredAlready(read, input.redirect, result)
  // The publisher's refusal (`tag-unpublish`): a best page still ranks the tag.
  if (item.activeBestPages > 0) {
    return failure(
      409,
      'tag_has_best_pages',
      'A best page ranks this tag. Retire that page or give it another tag first.'
    )
  }
  const decision = await retire({
    context,
    kind: 'tag',
    operation: { action: 'tag-unpublish', redirect: input.redirect, slug: input.slug },
    read,
    result,
    slug: input.slug,
    target: input.redirect
  })
  log(context, 'retire_tag', input.slug, decision.ok ? 'retired' : decision.error)
  return decision
}

// ---------------------------------------------------------------------------------------------
// Best pages

function bestPageFields(input: BestPageFields): BestPageFields {
  return {
    intro: input.intro.trim(),
    keyword: input.keyword.trim(),
    slug: input.slug.trim(),
    tag: input.tag.trim(),
    title: input.title.trim()
  }
}

async function bestPageProblem(
  context: AdminContext,
  fields: BestPageFields,
  checkSlug: boolean
): Promise<DecisionFailure | null> {
  if (checkSlug && !isTaxonomySlug(fields.slug)) return slugInvalid
  const text =
    textProblem(fields.keyword, TAXONOMY_LIMITS.keyword, 'a keyword') ??
    textProblem(fields.title, TAXONOMY_LIMITS.title, 'a title') ??
    textProblem(fields.intro, TAXONOMY_LIMITS.intro, 'an intro')
  if (text) return text
  const tags = await createAdminReadOperations({ client: context.client }).listActiveTags()
  return tags.some(tag => tag.slug === fields.tag)
    ? null
    : failure(422, 'invalid_tag', 'Choose an active tag.')
}

// A page with no tag (a manifest may rank a category alone) compares as an empty tag field.
const sameBestPage = (item: BestPageItem, fields: BestPageFields) =>
  item.slug === fields.slug &&
  item.keyword === fields.keyword &&
  item.title === fields.title &&
  item.intro === fields.intro &&
  (item.tag ?? '') === fields.tag

async function bestPageHolds(context: AdminContext, fields: BestPageFields): Promise<boolean> {
  const item = itemOf<BestPageItem>(await readState(context, 'best', fields.slug))
  return item?.active === 1 && sameBestPage(item, fields)
}

/** A best page's stored fields, as `best-page-update` compares them. */
function bestPageState(item: BestPageItem): BestPageState {
  return {
    category: item.category,
    heading: item.heading,
    intro: item.intro,
    keyword: item.keyword,
    keywordCheckedAt: item.keywordCheckedAt,
    keywordVolume: item.keywordVolume,
    listSize: item.listSize,
    order: item.order,
    tag: item.tag,
    title: item.title
  }
}

export function createBestPage(
  context: AdminContext,
  input: BestPageFields
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => createBestPageOnce(context, input))
}

async function createBestPageOnce(
  context: AdminContext,
  input: BestPageFields
): Promise<Decision<{ slug: string }>> {
  const fields = bestPageFields(input)
  const result = { slug: fields.slug }
  if (!isTaxonomySlug(fields.slug)) return slugInvalid
  const read = await readState(context, 'best', fields.slug)
  const item = itemOf<BestPageItem>(read)
  if (item) return item.active === 1 && sameBestPage(item, fields) ? replay(result) : slugTaken
  const problem = await bestPageProblem(context, fields, true)
  if (problem) return problem
  if (read.redirect) return redirectsElsewhere
  const decision = await publish({
    action: 'best-page-create',
    context,
    kind: 'best',
    operations: [
      {
        action: 'best-page-create',
        // The H1 is the title; the rest are the publisher's defaults.
        page: {
          category: null,
          heading: fields.title,
          intro: fields.intro,
          keyword: fields.keyword,
          keywordCheckedAt: null,
          keywordVolume: null,
          listSize: BEST_PAGE_LIST_SIZE.default,
          order: 0,
          slug: fields.slug,
          tag: fields.tag,
          title: fields.title
        }
      }
    ],
    read,
    result,
    routes: [pageRoute('best', fields.slug), indexRoute('best'), pageRoute('tag', fields.tag)],
    settled: () => bestPageHolds(context, fields),
    slug: fields.slug
  })
  log(context, 'create_best_page', fields.slug, decision.ok ? 'created' : decision.error)
  return decision
}

export function updateBestPage(
  context: AdminContext,
  input: Parameters<typeof updateBestPageOnce>[1]
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => updateBestPageOnce(context, input))
}

async function updateBestPageOnce(
  context: AdminContext,
  input: { expected: BestPageFields; page: BestPageFields; slug: string }
): Promise<Decision<{ slug: string }>> {
  const fields = bestPageFields(input.page)
  const renamed = fields.slug !== input.slug
  if (renamed && !isTaxonomySlug(fields.slug)) return slugInvalid
  const result = { slug: fields.slug }
  const read = await readState(context, 'best', input.slug)
  const item = itemOf<BestPageItem>(read)
  if (item?.active !== 1) {
    if (renamed && (await bestPageHolds(context, fields))) return replay(result)
    return notFound('best page')
  }
  if (sameBestPage(item, fields)) return replay(result)
  if (!sameBestPage(item, bestPageFields(input.expected))) return changed
  const problem = await bestPageProblem(context, fields, renamed)
  if (problem) return problem
  if (renamed) {
    const unavailable = await slugUnavailable(context, 'best', fields.slug, input.slug)
    if (unavailable) return unavailable
  }
  const expected = bestPageState(item)
  const page: BestPageState = {
    ...expected,
    // The H1 follows the title, unless it was set apart from it.
    heading: item.heading === item.title ? fields.title : item.heading,
    intro: fields.intro,
    keyword: fields.keyword,
    tag: fields.tag,
    title: fields.title
  }
  // The rename goes first, so the edit and the end-of-batch checks find the page by its new slug.
  const operations: TaxonomyOperation[] = renamed
    ? [{ action: 'taxonomy-rename', kind: 'best', slug: input.slug, to: fields.slug }]
    : []
  if (JSON.stringify(page) !== JSON.stringify(expected)) {
    operations.push({ action: 'best-page-update', expected, page, slug: fields.slug })
  }
  const decision = await publish({
    action: 'best-page-update',
    context,
    kind: 'best',
    operations,
    read,
    result,
    routes: [
      pageRoute('best', input.slug),
      pageRoute('best', fields.slug),
      indexRoute('best'),
      ...[item.tag, fields.tag].flatMap(tag => (tag ? [pageRoute('tag', tag)] : []))
    ],
    settled: () => bestPageHolds(context, fields),
    slug: input.slug
  })
  log(context, 'update_best_page', input.slug, decision.ok ? fields.slug : decision.error)
  return decision
}

const sameRefs = (a: readonly ListingRef[], b: readonly ListingRef[]) =>
  a.length === b.length &&
  a.every((ref, index) => ref.id === b[index]?.id && ref.slug === b[index]?.slug)

export function setBestPagePins(
  context: AdminContext,
  input: Parameters<typeof setBestPagePinsOnce>[1]
): Promise<Decision<{ pins: string[] }>> {
  return retryPublicationRace(() => setBestPagePinsOnce(context, input))
}

/**
 * A best page's pins, in order (#405): each a live listing of the page's pool (its tag's
 * listings), never one it excludes or a feature of a larger site, at most its list size. A pin
 * the page keeps keeps its blurb; the exclusions stay as they are.
 */
async function setBestPagePinsOnce(
  context: AdminContext,
  input: { expectedPins: ListingRef[]; pins: ListingRef[]; slug: string }
): Promise<Decision<{ pins: string[] }>> {
  const read = await readState(context, 'best', input.slug)
  const item = itemOf<BestPageItem>(read)
  if (item?.active !== 1) return notFound('best page')
  const current = item.pins.map(([id, slug]) => ({ id, slug }))
  const result = { pins: input.pins.map(pin => pin.id) }
  if (sameRefs(current, input.pins)) return replay(result)
  if (!sameRefs(current, input.expectedPins)) return changed
  if (new Set(input.pins.map(pin => pin.id)).size !== input.pins.length) {
    return failure(422, 'invalid_pins', 'Pin each listing once.')
  }
  if (input.pins.length > item.listSize) {
    return failure(422, 'invalid_pins', `Pin at most ${item.listSize} listings.`)
  }
  if (input.pins.some(pin => isFeatureListing(pin.id))) {
    return failure(
      422,
      'feature_listing',
      'A listing that names a feature of a larger site can’t be pinned.'
    )
  }
  const page = await createAdminReadOperations({ client: context.client }).getAdminBestPage(
    input.slug
  )
  const pool = new Map(page?.pool.map(listing => [listing.id, listing.slug]))
  if (input.pins.some(pin => pool.get(pin.id) !== pin.slug)) {
    return failure(
      422,
      'invalid_pins',
      item.tag
        ? 'Pin only live listings with this page’s tag.'
        : 'Pin only live listings in this page’s category.'
    )
  }
  const blurbs = new Map(item.pins.map(([id, , blurb]) => [id, blurb]))
  const withBlurb = (pin: ListingRef) => {
    const blurb = blurbs.get(pin.id)
    return blurb ? { ...pin, blurb } : { id: pin.id, slug: pin.slug }
  }
  const exclude = item.exclude.map(([id, slug]) => ({ id, slug }))
  const decision = await publish({
    action: 'best-page-pins',
    context,
    kind: 'best',
    operations: [
      {
        action: 'best-page-listings-set',
        exclude,
        expected: { exclude, pins: current.map(withBlurb) },
        pins: input.pins.map(withBlurb),
        slug: input.slug
      }
    ],
    read,
    result,
    routes: [pageRoute('best', input.slug), indexRoute('best')],
    settled: async () => {
      const after = itemOf<BestPageItem>(await readState(context, 'best', input.slug))
      return (
        after !== null &&
        sameRefs(
          after.pins.map(([id, slug]) => ({ id, slug })),
          input.pins
        )
      )
    },
    slug: input.slug
  })
  log(context, 'set_best_page_pins', input.slug, decision.ok ? 'set' : decision.error)
  return decision
}

export function retireBestPage(
  context: AdminContext,
  input: Parameters<typeof retireBestPageOnce>[1]
): Promise<Decision<{ slug: string }>> {
  return retryPublicationRace(() => retireBestPageOnce(context, input))
}

async function retireBestPageOnce(
  context: AdminContext,
  input: { redirect: TaxonomyTarget; slug: string }
): Promise<Decision<{ slug: string }>> {
  const read = await readState(context, 'best', input.slug)
  const item = itemOf<BestPageItem>(read)
  const result = { slug: input.slug }
  if (!item) return notFound('best page')
  if (item.active !== 1) return retiredAlready(read, input.redirect, result)
  const decision = await retire({
    context,
    kind: 'best',
    operation: { action: 'best-page-unpublish', redirect: input.redirect, slug: input.slug },
    read,
    result,
    slug: input.slug,
    target: input.redirect
  })
  log(context, 'retire_best_page', input.slug, decision.ok ? 'retired' : decision.error)
  return decision
}
