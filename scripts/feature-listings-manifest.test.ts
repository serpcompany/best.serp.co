import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { assertD1StatementLimits } from '../apps/web/src/db/sql-limits'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { buildPublicationPlan, parseManifest } from './d1-publisher.ts'
import {
  buildFeatureListingsManifest,
  FEATURE_LISTINGS_MANIFEST_ID,
  readFeatureListings
} from './feature-listings-manifest.ts'

const committed = () =>
  readFileSync(resolve('d1/publications', `${FEATURE_LISTINGS_MANIFEST_ID}.yaml`), 'utf8')

/** #409: #349's `featureListings`, moved from app code into `listings.is_feature_listing`. */
describe('the feature listings manifest (#409)', () => {
  it('keeps the committed manifest identical to what the mapping generates', () => {
    expect(committed()).toBe(buildFeatureListingsManifest(readFeatureListings()))
  })

  it('sets the flag on exactly the mapping’s 83 feature listings, by id and slug', () => {
    const features = readFeatureListings()
    expect(features).toHaveLength(83)
    const manifest = parseManifest(committed())
    expect(manifest.concurrency).toBe('rows')
    expect(
      manifest.operations.map(operation =>
        operation.action === 'listing-feature-listing-set'
          ? [operation.id, operation.slug, operation.expected, operation.featureListing]
          : operation.action
      )
    ).toEqual(features.map(entry => [entry.id, entry.slug, false, true]))
  })

  it('refuses a listing named twice', () => {
    const [first] = readFeatureListings()
    if (!first) throw new Error('The mapping has no feature listings.')
    expect(() => buildFeatureListingsManifest([first, first])).toThrow(/listed twice/u)
  })

  it('applies at any version without touching content, refuses a listing that changed, and applies once', () => {
    const features = readFeatureListings()
    const source = committed()
    const db = new DatabaseSync(':memory:')
    for (const migration of freshMigrationNames())
      db.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
    const now = '2026-10-12T00:00:00.000Z'
    db.exec(`INSERT INTO categories (slug,name) VALUES ('tools','Tools');
      INSERT INTO publication_state (id,version,checksum,published_at) VALUES (1,57,'${'a'.repeat(64)}','${now}')`)
    const insertListing = db.prepare(
      "INSERT INTO listings (id,slug,name,description,website,status,published_at,source_kind,source_identity,checksum,updated_at) VALUES (?,?,?,'d',?,'draft',?,'test','fixture',?,?)"
    )
    const file = db.prepare(
      "INSERT INTO listing_categories (listing_id,category_id,sort_order,is_primary) SELECT ?,id,0,1 FROM categories WHERE slug='tools'"
    )
    for (const entry of [...features, { id: 'lst_not_a_feature', slug: 'not-a-feature.example' }]) {
      insertListing.run(
        entry.id,
        entry.slug,
        entry.slug,
        `https://${entry.slug}/`,
        now,
        'c'.repeat(64),
        now
      )
      file.run(entry.id)
    }
    db.exec("UPDATE listings SET status='approved'")
    const apply = (text: string) => {
      const state = db
        .prepare('SELECT version,checksum FROM publication_state WHERE id=1')
        .get() as { checksum: string; version: number }
      const plan = buildPublicationPlan(parseManifest(text), text, now, state)
      expect(plan.statements.length).toBeLessThanOrEqual(2000)
      db.exec('BEGIN')
      try {
        for (const statement of plan.statements) {
          assertD1StatementLimits(statement.query, statement.bindings)
          db.prepare(statement.query).run(...(statement.bindings as SQLInputValue[]))
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const snapshot = () =>
      db
        .prepare(
          'SELECT id,slug,is_feature_listing,checksum,updated_at,is_active FROM listings ORDER BY id'
        )
        .all()

    // A listing flagged since generation refuses the whole batch, writing nothing.
    const flagged = features.find(entry => entry.slug === 'slack.com')?.id ?? ''
    db.prepare('UPDATE listings SET is_feature_listing=1 WHERE id=?').run(flagged)
    const before = snapshot()
    expect(() => apply(source)).toThrow(
      /listing-feature-listing-set slack\.com: the listing is not approved, or its slug or feature flag changed since the manifest/u
    )
    expect(snapshot()).toEqual(before)
    db.prepare('UPDATE listings SET is_feature_listing=0 WHERE id=?').run(flagged)

    const unflagged = snapshot() as Array<Record<string, unknown>>
    apply(source)
    const ids = new Set(features.map(entry => entry.id))
    // Only the flag changes: checksums, lastmods, and live state stay as they were.
    expect(snapshot()).toEqual(
      unflagged.map(row => ({ ...row, is_feature_listing: ids.has(String(row.id)) ? 1 : 0 }))
    )
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM listing_events WHERE event_type='edited' AND json_extract(detail,'$.fields[0]')='feature listing'"
        )
        .get()
    ).toEqual({ count: 83 })
    expect(db.prepare('SELECT version FROM publication_state WHERE id=1').get()).toEqual({
      version: 58
    })
    // Applied once: a second run (under another id) finds the flags set and writes nothing.
    const again = source.replace(`id: ${FEATURE_LISTINGS_MANIFEST_ID}`, 'id: 2026-10-12-again')
    const applied = snapshot()
    expect(() => apply(again)).toThrow(/its slug or feature flag changed since the manifest/u)
    expect(snapshot()).toEqual(applied)
  })
})
