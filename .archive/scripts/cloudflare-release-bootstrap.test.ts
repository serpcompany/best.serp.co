/**
 * ARCHIVED (serpcompany/best.serp.co#315): the tests of the one-time production bootstrap
 * (`import`, `verify-import`), cut from `scripts/cloudflare-release.test.ts` as they were before
 * #315, with the fixtures they used. History only: not built, linted, or run; the commands they
 * test are in `cloudflare-release-bootstrap.ts` beside it.
 */
const at = '2026-01-01T00:00:00.000Z'
const targetChecksum = 'b'.repeat(64)
const fixtureSql = [
  'PRAGMA foreign_keys = ON;',
  `INSERT INTO migration_runs (id, schema_version, manifest_identity, input_checksum, target_checksum, affected_records, outcome, started_at, completed_at) VALUES ('migration-fixture', 1, 'fixture-v1', '${'a'.repeat(64)}', '${targetChecksum}', 1, 'started', '${at}', NULL);`,
  `INSERT INTO categories (slug, name, description, sort_order, is_active, created_at, updated_at) VALUES ('video-downloaders', 'Video Downloaders', 'Fixture category.', 0, 1, '${at}', '${at}');`,
  `INSERT INTO listings (id, slug, name, description, website, content, entity_type, priority, is_unofficial, is_featured, is_active, status, published_at, display_order, source_kind, source_identity, source_updated_at, checksum, created_at, updated_at) VALUES ('lst_fixture0001', 'fixture-tool', 'Fixture Tool', 'A fixture listing.', 'https://example.com/', NULL, NULL, NULL, 0, 1, 1, 'draft', '${at}', 0, 'fixture', 'fixture-tool', NULL, '${'c'.repeat(64)}', '${at}', '${at}');`,
  `INSERT INTO listing_categories (listing_id, category_id, sort_order, is_primary) SELECT 'lst_fixture0001', id, 0, 1 FROM categories WHERE slug = 'video-downloaders';`,
  `INSERT INTO listing_media (listing_id, kind, url, sort_order) VALUES ('lst_fixture0001', 'logo', '/logo.png', 0);`,
  `UPDATE listings SET status = 'approved' WHERE id = 'lst_fixture0001';`,
  `INSERT INTO publication_state (id, version, manifest_id, checksum, published_at) VALUES (1, 1, 'fixture-v1', '${targetChecksum}', '${at}');`,
  `UPDATE migration_runs SET outcome = 'succeeded', completed_at = '${at}' WHERE id = 'migration-fixture';`
].join('\n')

const paths: ImportArtifactPaths = {
  batchDirectory: join(fixtureDirectory, 'no-batches'),
  compressedSqlPath: join(fixtureDirectory, 'fixture.sql.br'),
  parityReportPath: join(fixtureDirectory, 'parity.yaml')
}
writeFileSync(paths.compressedSqlPath, brotliCompressSync(Buffer.from(fixtureSql)))

function fixtureReport(overrides: Partial<ParityReport['target']> = {}): ParityReport {
  return {
    artifact: { sqlChecksum: sha256(fixtureSql) },
    parity: {
      categoryMembershipCount: 1,
      faqCount: 0,
      featuredCount: 1,
      importBatches: 1,
      mediaCount: 1,
      primaryCategoryCount: 1,
      resourceLinkCount: 0
    },
    target: {
      categoryCount: 1,
      checksum: targetChecksum,
      listingCount: 1,
      publicationVersion: 1,
      ...overrides
    }
  }
}

describe('one-time catalog bootstrap', () => {
  it('migrates, imports, and verifies an empty database exactly once', async () => {
    const { target } = sqliteD1()
    const report = fixtureReport()

    const empty = await checkDatabase(target)
    expect(empty.missingMigrations).toEqual(freshMigrationNames())
    expect(() => assertDatabaseReady(empty, 'production')).toThrow('database-and-worker')

    target.applyMigrations()
    await expect(
      checkDatabase(target).then(readiness => assertDatabaseReady(readiness, 'production'))
    ).rejects.toThrow('bootstrap-production-d1.yml')

    await expect(importReviewedCatalog(target, 'production', { paths, report })).resolves.toEqual({
      sqlChecksum: sha256(fixtureSql),
      status: 'imported'
    })
    await expect(
      verifyImportedCatalog(target, 'production', { pageSize: 1, paths, report })
    ).resolves.toMatchObject({ checksum: targetChecksum, listings: 1, version: 1 })
    const ready = await checkDatabase(target)
    expect(() => assertDatabaseReady(ready, 'production')).not.toThrow()
    expect(ready.publication).toEqual({ checksum: targetChecksum, rows: 1, version: 1 })

    await expect(importReviewedCatalog(target, 'production', { paths, report })).resolves.toEqual({
      sqlChecksum: sha256(fixtureSql),
      status: 'already-imported'
    })
  })

  it('applies the migrations itself when bootstrapping a database with no tables', async () => {
    const { target } = sqliteD1()
    await expect(
      importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
    ).resolves.toMatchObject({ status: 'imported' })
    const readiness = await checkDatabase(target)
    expect(readiness.appliedMigrations).toEqual(freshMigrationNames())
    expect(() => assertDatabaseReady(readiness, 'production')).not.toThrow()
  })

  it('refuses a populated database before applying any migration', async () => {
    const { database, target } = sqliteD1()
    database.exec(
      "CREATE TABLE publication_state (id INTEGER PRIMARY KEY, version INTEGER, checksum TEXT); INSERT INTO publication_state VALUES (1, 7, 'live')"
    )
    let migrations = 0
    const spy: D1Target = {
      ...target,
      applyMigrations: () => {
        migrations += 1
      }
    }
    await expect(
      importReviewedCatalog(spy, 'production', { paths, report: fixtureReport() })
    ).rejects.toThrow('only into an empty database')
    expect(migrations).toBe(0)
  })

  it('refuses a database that already holds other or partial catalog data', async () => {
    for (const statement of [
      `INSERT INTO categories (slug, name) VALUES ('other', 'Other')`,
      `INSERT INTO migration_runs (id, schema_version, manifest_identity, input_checksum, target_checksum, affected_records, outcome) VALUES ('partial', 1, 'partial', 'x', 'y', 0, 'started')`,
      `INSERT INTO publication_state (id, version, checksum) VALUES (1, 3, '${'d'.repeat(64)}')`
    ]) {
      const { database, target } = sqliteD1()
      target.applyMigrations()
      database.exec(statement)
      await expect(
        importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
      ).rejects.toThrow('only into an empty database')
    }
  })

  it('refuses an unverifiable or tampered artifact before touching D1', async () => {
    const { target } = sqliteD1()
    target.applyMigrations()
    const unverified = fixtureReport()
    unverified.artifact = {}
    await expect(
      importReviewedCatalog(target, 'production', { paths, report: unverified })
    ).rejects.toThrow('no artifact.sqlChecksum')
    const tampered = fixtureReport()
    tampered.artifact = { sqlChecksum: 'e'.repeat(64) }
    await expect(
      importReviewedCatalog(target, 'production', { paths, report: tampered })
    ).rejects.toThrow('reviewed artifact checksum')
    expect((await checkDatabase(target)).publication.rows).toBe(0)
  })

  it('names every table and parity count that differs from the reviewed import', async () => {
    const { database, target } = sqliteD1()
    target.applyMigrations()
    await importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })

    await expect(
      verifyImportedCatalog(target, 'production', {
        paths,
        report: fixtureReport({ listingCount: 2 })
      })
    ).rejects.toThrow('listing_count is 1, expected 2')

    database.exec("UPDATE listings SET name = 'Tampered' WHERE id = 'lst_fixture0001'")
    await expect(
      verifyImportedCatalog(target, 'production', { paths, report: fixtureReport() })
    ).rejects.toThrow('Tables: listings.')
  })

  it('requires the runtime tables to be empty at bootstrap', async () => {
    const { database, target } = sqliteD1()
    target.applyMigrations()
    await importReviewedCatalog(target, 'production', { paths, report: fixtureReport() })
    database.exec(
      "INSERT INTO users (id, name, email, email_verified) VALUES ('planted', '', 'x@example.com', 1)"
    )
    database.exec(
      "INSERT INTO sessions (id, expires_at, token, user_id) VALUES ('s', 1, 't', 'planted')"
    )
    database.exec(
      "INSERT INTO email_deliveries (template_id, event_key, provider, status) VALUES ('t', 'evt', 'p', 'sent')"
    )
    await expect(
      verifyImportedCatalog(target, 'production', { paths, report: fixtureReport() })
    ).rejects.toThrow(
      'Runtime tables must be empty at bootstrap: users, sessions, email_deliveries.'
    )
  })
})
