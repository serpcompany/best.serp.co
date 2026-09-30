import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCutoverUnlockedPlan } from '@serpdirectory/data-ops/cutover-lock'
import { parse } from 'yaml'
import { z } from 'zod'
import { resolveSiteTarget, type SiteId, siteIds } from './site-targets'

const slug = z.string().regex(/^[a-z0-9.-]+$/)
const categorySlug = z.string().regex(/^[a-z0-9-]+$/)
const listingId = z.string().regex(/^lst_[a-z0-9][a-z0-9_-]{7,63}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)

function unique<T>(message: string, key: (value: T) => string) {
  return (values: T[], context: z.RefinementCtx): void => {
    const seen = new Set<string>()
    values.forEach((value, index) => {
      const id = key(value)
      if (seen.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message, path: [index] })
      seen.add(id)
    })
  }
}

const categories = z
  .array(categorySlug)
  .min(1)
  .superRefine(unique('Duplicate affected category.', value => value))
const category = z
  .object({
    slug: categorySlug,
    name: z.string().min(1),
    description: z.string().default(''),
    order: z.number().int().nonnegative().default(0)
  })
  .strict()
const resource = z.object({ label: z.string().min(1), url: z.string().url() }).strict()
const faq = z.object({ question: z.string().min(1), answer: z.string().min(1) }).strict()
const media = z
  .object({
    logo: z.string().min(1).optional(),
    images: z
      .array(z.string().min(1))
      .superRefine(unique('Duplicate listing image.', value => value))
      .optional(),
    video: z.string().min(1).optional()
  })
  .strict()
const listing = z
  .object({
    id: listingId,
    slug,
    name: z.string().min(1),
    description: z.string().min(1),
    website: z.string().url(),
    content: z.string().optional(),
    entityType: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    isUnofficial: z.boolean().default(false),
    featured: z.boolean().default(false),
    publishedAt: z.string().datetime(),
    categories: z
      .array(categorySlug)
      .min(1)
      .superRefine(unique('Duplicate listing category.', value => value)),
    media: media.optional(),
    resources: z
      .array(resource)
      .superRefine(unique('Duplicate listing resource.', value => `${value.label}\0${value.url}`))
      .optional(),
    faqs: z
      .array(faq)
      .superRefine(unique('Duplicate listing FAQ.', value => value.question))
      .optional()
  })
  .strict()
const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('listing-create'), listing }).strict(),
  z
    .object({ action: z.literal('listing-update'), listing, previousCategories: categories })
    .strict(),
  z.object({ action: z.literal('listing-unpublish'), id: listingId, slug, categories }).strict(),
  z
    .object({
      action: z.literal('listing-slug-change'),
      id: listingId,
      from: slug,
      to: slug,
      categories,
      reason: z.string().min(1)
    })
    .strict(),
  z.object({ action: z.literal('category-create'), category }).strict(),
  z.object({ action: z.literal('category-update'), category }).strict(),
  z.object({ action: z.literal('category-unpublish'), slug: categorySlug }).strict()
])
const provenance = z
  .object({
    actor: z.string().regex(/^[a-zA-Z0-9@._-]{2,128}$/),
    workflow: z.string().regex(/^[a-z0-9][a-z0-9._/-]{1,127}$/),
    beforeChecksum: checksum
  })
  .strict()
export const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]+$/),
    siteId: z.enum(siteIds),
    basePublicationVersion: z.number().int().nonnegative(),
    provenance,
    operations: z.array(operation).min(1)
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>()
    const slugs = new Set<string>()
    const categoryTargets = new Set<string>()
    value.operations.forEach((op, index) => {
      if (op.action === 'listing-slug-change' && op.from === op.to)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Old and new slugs must differ.',
          path: ['operations', index, 'to']
        })
      if (op.action.startsWith('category-')) {
        const target = op.action === 'category-unpublish' ? op.slug : op.category.slug
        if (categoryTargets.has(target))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Duplicate category operation target.',
            path: ['operations', index]
          })
        categoryTargets.add(target)
        return
      }
      const id =
        op.action === 'listing-create' || op.action === 'listing-update' ? op.listing.id : op.id
      const target =
        op.action === 'listing-create' || op.action === 'listing-update'
          ? op.listing.slug
          : op.action === 'listing-slug-change'
            ? op.to
            : op.slug
      if (ids.has(id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate listing operation ID.',
          path: ['operations', index]
        })
      if (slugs.has(target))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Duplicate listing operation slug.',
          path: ['operations', index]
        })
      ids.add(id)
      slugs.add(target)
    })
  })
export type PublicationManifest = z.infer<typeof manifestSchema>
type Listing = z.infer<typeof listing>
export interface PlannedStatement {
  query: string
  bindings: unknown[]
}
export interface PublicationPlan {
  affectedRoutes: string
  afterChecksum: string
  inputChecksum: string
  manifest: PublicationManifest
  statements: PlannedStatement[]
}
interface BatchStatement {
  bind(...values: unknown[]): BatchStatement
}
export interface PublicationDatabase {
  prepare(query: string): BatchStatement
  batch<T = unknown>(statements: BatchStatement[]): Promise<T[]>
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const statement = (query: string, ...bindings: unknown[]): PlannedStatement => ({ query, bindings })
function cutoverGuardStatement(siteId: SiteId): PlannedStatement {
  const guard = assertCutoverUnlockedPlan(siteId)
  return statement(guard.sql, ...guard.params)
}
function membershipGuard(id: string, expected: string[], siteId: SiteId): PlannedStatement {
  return statement(
    `INSERT INTO publication_guard SELECT CASE WHEN (SELECT COUNT(*) FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? AND c.site_id=? AND c.is_active=1)=? AND NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id=lc.category_id WHERE lc.listing_id=? AND c.site_id=? AND c.is_active=1 AND c.slug NOT IN (${expected.map(() => '?').join(', ')})) THEN 1 ELSE 0 END`,
    id,
    siteId,
    expected.length,
    id,
    siteId,
    ...expected
  )
}
function listingStatements(
  value: Listing,
  mode: 'create' | 'update',
  manifestId: string,
  now: string,
  siteId: SiteId
): PlannedStatement[] {
  const out: PlannedStatement[] = []
  if (mode === 'create')
    out.push(
      statement(
        "INSERT INTO listings (id,site_id,slug,name,description,website,content,entity_type,priority,is_unofficial,is_featured,is_active,status,published_at,display_order,source_kind,source_identity,source_updated_at,checksum,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'draft',?,(SELECT COALESCE(MAX(display_order),-1)+1 FROM listings WHERE site_id=?),'yaml-manifest-v1',?,?,?,?,?)",
        value.id,
        siteId,
        value.slug,
        value.name,
        value.description,
        value.website,
        value.content ?? null,
        value.entityType ?? null,
        value.priority ?? null,
        value.isUnofficial,
        value.featured,
        value.publishedAt,
        siteId,
        manifestId,
        now,
        hash(JSON.stringify(value)),
        now,
        now
      )
    )
  else
    out.push(
      statement(
        "UPDATE listings SET status='draft' WHERE site_id=? AND id=? AND slug=? AND status='approved' AND is_active=1",
        siteId,
        value.id,
        value.slug
      ),
      statement('INSERT INTO publication_guard VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END)'),
      statement('DELETE FROM listing_categories WHERE listing_id=?', value.id),
      statement('DELETE FROM listing_media WHERE listing_id=?', value.id),
      statement('DELETE FROM listing_resource_links WHERE listing_id=?', value.id),
      statement('DELETE FROM listing_faqs WHERE listing_id=?', value.id),
      statement(
        "UPDATE listings SET name=?,description=?,website=?,content=?,entity_type=?,priority=?,is_unofficial=?,is_featured=?,is_active=1,published_at=?,source_kind='yaml-manifest-v1',source_identity=?,source_updated_at=?,checksum=?,updated_at=? WHERE id=?",
        value.name,
        value.description,
        value.website,
        value.content ?? null,
        value.entityType ?? null,
        value.priority ?? null,
        value.isUnofficial,
        value.featured,
        value.publishedAt,
        manifestId,
        now,
        hash(JSON.stringify(value)),
        now,
        value.id
      )
    )
  value.categories.forEach((cat, order) =>
    out.push(
      statement(
        'INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,?,? FROM categories WHERE site_id=? AND slug=? AND is_active=1',
        value.id,
        order,
        order === 0,
        siteId,
        cat
      )
    )
  )
  out.push(
    statement(
      'INSERT INTO publication_guard VALUES (CASE WHEN (SELECT COUNT(*) FROM listing_categories WHERE listing_id=?)=? THEN 1 ELSE 0 END)',
      value.id,
      value.categories.length
    )
  )
  if (value.media?.logo)
    out.push(
      statement(
        "INSERT INTO listing_media (listing_id,kind,url,sort_order) VALUES (?,'logo',?,0)",
        value.id,
        value.media.logo
      )
    )
  value.media?.images?.forEach((url, order) =>
    out.push(
      statement(
        "INSERT INTO listing_media (listing_id,kind,url,sort_order) VALUES (?,'image',?,?)",
        value.id,
        url,
        order
      )
    )
  )
  if (value.media?.video)
    out.push(
      statement(
        "INSERT INTO listing_media (listing_id,kind,url,sort_order) VALUES (?,'video',?,0)",
        value.id,
        value.media.video
      )
    )
  value.resources?.forEach((item, order) =>
    out.push(
      statement(
        'INSERT INTO listing_resource_links (listing_id,label,url,sort_order) VALUES (?,?,?,?)',
        value.id,
        item.label,
        item.url,
        order
      )
    )
  )
  value.faqs?.forEach((item, order) =>
    out.push(
      statement(
        'INSERT INTO listing_faqs (listing_id,question,answer,sort_order) VALUES (?,?,?,?)',
        value.id,
        item.question,
        item.answer,
        order
      )
    )
  )
  out.push(statement("UPDATE listings SET status='approved' WHERE id=?", value.id))
  return out
}
export const parseManifest = (source: string): PublicationManifest =>
  manifestSchema.parse(parse(source))
export function buildPublicationPlan(
  manifest: PublicationManifest,
  source: string,
  now: string
): PublicationPlan {
  const siteId = manifest.siteId
  const inputChecksum = hash(source)
  const afterChecksum = hash(`${manifest.provenance.beforeChecksum}\0${inputChecksum}`)
  const routes = new Set<string>()
  const addCategories = (values: string[]) =>
    values.forEach(value => routes.add(`/categories/${value}/`))
  const statements: PlannedStatement[] = [
    cutoverGuardStatement(siteId),
    statement('PRAGMA foreign_keys = ON'),
    statement('CREATE TEMP TABLE publication_guard (valid INTEGER NOT NULL CHECK (valid=1))'),
    statement(
      'INSERT INTO publication_guard SELECT CASE WHEN version=? AND checksum=? THEN 1 ELSE 0 END FROM publication_state WHERE site_id=?',
      manifest.basePublicationVersion,
      manifest.provenance.beforeChecksum,
      siteId
    ),
    statement(
      "INSERT INTO publication_runs (id,site_id,manifest_id,base_version,input_checksum,outcome,started_at,actor,workflow,before_checksum,after_checksum) VALUES (?,?,?,?,?,'started',?,?,?,?,?) ON CONFLICT(site_id,manifest_id) DO UPDATE SET base_version=excluded.base_version,input_checksum=excluded.input_checksum,outcome='started',error=NULL,started_at=excluded.started_at,completed_at=NULL,actor=excluded.actor,workflow=excluded.workflow,before_checksum=excluded.before_checksum,after_checksum=excluded.after_checksum WHERE publication_runs.outcome='failed'",
      `publish_${hash(manifest.id).slice(0, 24)}`,
      siteId,
      manifest.id,
      manifest.basePublicationVersion,
      inputChecksum,
      now,
      manifest.provenance.actor,
      manifest.provenance.workflow,
      manifest.provenance.beforeChecksum,
      afterChecksum
    )
  ]
  for (const op of manifest.operations) {
    if (op.action === 'category-create') {
      statements.push(
        statement(
          'INSERT INTO categories (site_id,slug,name,description,sort_order,is_active) VALUES (?,?,?,?,?,1)',
          siteId,
          op.category.slug,
          op.category.name,
          op.category.description,
          op.category.order
        )
      )
      addCategories([op.category.slug])
    }
    if (op.action === 'category-update') {
      statements.push(
        statement(
          'UPDATE categories SET name=?,description=?,sort_order=?,is_active=1,updated_at=? WHERE site_id=? AND slug=?',
          op.category.name,
          op.category.description,
          op.category.order,
          now,
          siteId,
          op.category.slug
        ),
        statement('INSERT INTO publication_guard VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END)')
      )
      addCategories([op.category.slug])
    }
    if (op.action === 'category-unpublish') {
      statements.push(
        statement(
          "UPDATE categories SET is_active=0,updated_at=? WHERE site_id=? AND slug=? AND NOT EXISTS (SELECT 1 FROM listing_categories lc JOIN listings l ON l.id=lc.listing_id WHERE lc.category_id=categories.id AND l.status='approved' AND l.is_active=1)",
          now,
          siteId,
          op.slug
        ),
        statement('INSERT INTO publication_guard VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END)')
      )
      addCategories([op.slug])
    }
    if (op.action === 'listing-create' || op.action === 'listing-update') {
      if (op.action === 'listing-update') {
        statements.push(membershipGuard(op.listing.id, op.previousCategories, siteId))
        addCategories(op.previousCategories)
      }
      statements.push(
        ...listingStatements(
          op.listing,
          op.action === 'listing-create' ? 'create' : 'update',
          manifest.id,
          now,
          siteId
        )
      )
      routes.add(`/products/${op.listing.slug}/`)
      addCategories(op.listing.categories)
    }
    if (op.action === 'listing-unpublish') {
      statements.push(
        membershipGuard(op.id, op.categories, siteId),
        statement(
          "UPDATE listings SET is_active=0,updated_at=? WHERE site_id=? AND id=? AND slug=? AND status='approved' AND is_active=1",
          now,
          siteId,
          op.id,
          op.slug
        ),
        statement('INSERT INTO publication_guard VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END)')
      )
      routes.add(`/products/${op.slug}/`)
      addCategories(op.categories)
    }
    if (op.action === 'listing-slug-change') {
      statements.push(
        membershipGuard(op.id, op.categories, siteId),
        statement(
          "UPDATE listings SET slug=?,updated_at=? WHERE site_id=? AND id=? AND slug=? AND status='approved' AND is_active=1 AND NOT EXISTS (SELECT 1 FROM listings conflict WHERE conflict.site_id=? AND conflict.slug=?)",
          op.to,
          now,
          siteId,
          op.id,
          op.from,
          siteId,
          op.to
        ),
        statement('INSERT INTO publication_guard VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END)'),
        statement(
          'INSERT INTO listing_slug_redirects (site_id,listing_id,old_slug,new_slug,manifest_id,reason,created_at) VALUES (?,?,?,?,?,?,?)',
          siteId,
          op.id,
          op.from,
          op.to,
          manifest.id,
          op.reason,
          now
        )
      )
      routes.add(`/products/${op.from}/`)
      routes.add(`/products/${op.to}/`)
      addCategories(op.categories)
    }
  }
  const affectedRoutes = [
    ...routes,
    '/',
    '/products/',
    '/search/',
    '/sitemap-index.xml',
    '/listings-sitemap.xml',
    '/taxonomies-sitemap.xml',
    '/rss.xml'
  ]
    .sort()
    .join('\n')
  statements.push(
    statement(
      'UPDATE publication_state SET version=?,manifest_id=?,checksum=?,published_at=? WHERE site_id=? AND version=? AND checksum=?',
      manifest.basePublicationVersion + 1,
      manifest.id,
      afterChecksum,
      now,
      siteId,
      manifest.basePublicationVersion,
      manifest.provenance.beforeChecksum
    ),
    statement('INSERT INTO publication_guard VALUES (CASE WHEN changes()=1 THEN 1 ELSE 0 END)'),
    statement(
      "UPDATE publication_runs SET published_version=?,affected_records=?,affected_routes=?,outcome='succeeded',completed_at=? WHERE site_id=? AND manifest_id=? AND before_checksum=? AND after_checksum=?",
      manifest.basePublicationVersion + 1,
      manifest.operations.length,
      affectedRoutes,
      now,
      siteId,
      manifest.id,
      manifest.provenance.beforeChecksum,
      afterChecksum
    )
  )
  return { affectedRoutes, afterChecksum, inputChecksum, manifest, statements }
}
export async function executePublicationPlan(
  database: PublicationDatabase,
  plan: PublicationPlan
): Promise<void> {
  await database.batch(
    plan.statements.map(item => database.prepare(item.query).bind(...item.bindings))
  )
}
export function publishManifest(manifestPath: string): void {
  const source = readFileSync(resolve(manifestPath), 'utf8')
  const manifest = parseManifest(source)
  const target = resolveSiteTarget(manifest.siteId)
  const config = JSON.parse(readFileSync(resolve(target.local.configPath), 'utf8')) as {
    name?: string
    vars?: { D1_RUNTIME_ENV?: string; SITE_ID?: string }
    d1_databases?: Array<{ binding?: string; database_id?: string; database_name?: string }>
  }
  const binding = config.d1_databases?.find(item => item.binding === 'DB')
  if (
    config.name !== target.local.workerName ||
    config.vars?.D1_RUNTIME_ENV !== 'local' ||
    config.vars.SITE_ID !== target.siteId ||
    binding?.database_name !== target.local.databaseName ||
    binding.database_id !== target.local.databaseId
  )
    throw new Error('Refusing to publish outside the dedicated local D1 binding.')
  buildPublicationPlan(manifest, source, new Date().toISOString())
  throw new Error(
    'CLI publication is disabled: an atomic D1Database.batch binding is required. The manifest was validated but no changes were made.'
  )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.argv[2]) throw new Error('Manifest path is required.')
  publishManifest(process.argv[2])
}
