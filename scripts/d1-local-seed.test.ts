import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  fixtureSeedImages,
  fixtureSeedListings,
  fixtureSeedStatements
} from '../apps/web/e2e/fixture-seed'
import {
  SEED_MEDIA_ORIGIN,
  SEED_NOW,
  seedFacts,
  seedFillerListings,
  seedListings,
  seedTags,
  seedUsers
} from '../apps/web/e2e/seed-facts'
import { freshMigrationNames, freshMigrationsDirectory } from './d1-drizzle-local'
import { runLocalD1Command } from './d1-local-guard'
import {
  assertLocalSeedTarget,
  assertResettableStateRoot,
  isSeeded,
  resetLocalState,
  type SeedQuery,
  seedFactViolations,
  seedFinishStatement,
  seedIncomplete,
  seedStartStatements
} from './d1-local-seed'
import {
  applicationColumnInventory,
  applicationTableNames,
  orderedRowsSql
} from './d1-table-inventory'
import { project } from './project'

const temporaryDirectories: string[] = []

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'best-serp-co-seed-'))
  temporaryDirectories.push(directory)
  return directory
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  for (const migration of freshMigrationNames()) {
    database.exec(readFileSync(resolve(freshMigrationsDirectory, migration), 'utf8'))
  }
  return database
}

function queryOf(database: DatabaseSync): SeedQuery {
  return (sql, params = []) => database.prepare(sql).all(...params) as Record<string, unknown>[]
}

/** The seed's rows without its hosted media, as `pnpm db:seed:local` writes them. */
function seededDatabase(): DatabaseSync {
  const database = migratedDatabase()
  database.exec('BEGIN')
  for (const statement of [...seedStartStatements(), seedFinishStatement()]) {
    database.prepare(statement.sql).run(...statement.params)
  }
  database.exec('COMMIT')
  return database
}

function allRows(database: DatabaseSync): Record<string, unknown> {
  return Object.fromEntries(
    applicationTableNames.map(table => [table, database.prepare(orderedRowsSql(table)).all()])
  )
}

/** A local Worker config as `validateCanonicalLocalConfig` accepts it. */
function localConfig(): Record<string, unknown> {
  return {
    assets: { binding: 'ASSETS', directory: resolve(project.appDirectory, '.open-next/assets') },
    d1_databases: [
      {
        binding: 'DB',
        database_id: project.local.databaseId,
        database_name: project.local.databaseName,
        migrations_dir: resolve('apps/web/drizzle'),
        migrations_table: project.migrationsTable
      }
    ],
    main: resolve(project.workerEntryPath),
    name: project.local.workerName,
    r2_buckets: [{ binding: 'MEDIA', bucket_name: project.local.media.bucket }],
    vars: { D1_RUNTIME_ENV: 'local', MEDIA_BASE_URL: project.local.media.baseUrl }
  }
}

describe('fixture seed (#312)', () => {
  it('writes rows that match its facts module', () => {
    const database = seededDatabase()
    try {
      const query = queryOf(database)
      expect(seedFactViolations(query, { marker: true, media: false })).toEqual([])
      expect(isSeeded(query)).toBe(true)
      // The facts name the first and last filler, and how many there are.
      const writers = query(
        "SELECT name, slug FROM listings WHERE slug LIKE 'fixture-writer-%' ORDER BY slug"
      )
      expect(writers).toHaveLength(seedFillerListings.count)
      expect(writers[0]).toEqual({ ...seedFillerListings.first })
      expect(writers.at(-1)).toEqual({ ...seedFillerListings.last })
      // Every published listing but the logo-less one gets a hosted logo; the detail listing an
      // image too.
      const images = fixtureSeedImages()
      expect(images.filter(image => image.kind === 'logo')).toHaveLength(seedFacts.hostedLogoCount)
      expect(images.filter(image => image.kind === 'image')).toHaveLength(
        seedFacts.hostedImageCount
      )
      const published = new Set(
        query(
          "SELECT id FROM listings WHERE status='approved' AND is_active=1 AND published_at IS NOT NULL"
        ).map(row => row.id)
      )
      expect(images.every(image => published.has(image.listingId))).toBe(true)
    } finally {
      database.close()
    }
  })

  it('reports where a local D1 departs from the facts', () => {
    const database = seededDatabase()
    try {
      database
        .prepare('UPDATE listings SET is_active=0 WHERE slug=?')
        .run(seedListings.claimable.slug)
      database.prepare('UPDATE tags SET is_active=0 WHERE slug=?').run(seedTags.empty.slug)
      expect(seedFactViolations(queryOf(database), { marker: true, media: false })).toEqual(
        expect.arrayContaining([
          `published listings: expected ${seedFacts.listingCount}, found ${seedFacts.listingCount - 1}`,
          `${seedListings.claimable.slug} state: expected "published", found "unpublished"`,
          // Fixture Canvas carries two tags.
          `${seedTags.whiteboards.slug} published listings: expected 2, found 1`,
          expect.stringMatching(/^active tags: /u)
        ])
      )
      // Without hosted media, the media facts fail.
      expect(seedFactViolations(queryOf(database), { marker: false, media: true })).toEqual(
        expect.arrayContaining([
          `listings with a hosted logo: expected ${seedFacts.hostedLogoCount}, found 0`
        ])
      )
      expect(isSeeded(queryOf(migratedDatabase()))).toBe(false)
    } finally {
      database.close()
    }
  })

  it('tells agent:dev to seed a local D1 a failed seed left half-written (#313)', () => {
    // Migrated but empty: the seed failed before its batch, or between its migrations and it.
    expect(seedIncomplete(queryOf(migratedDatabase()))).toBe(true)
    // Not even migrated: a table is missing.
    expect(seedIncomplete(queryOf(new DatabaseSync(':memory:')))).toBe(true)
    // The batch ran, but hosting the media failed: the run never finished.
    const started = migratedDatabase()
    for (const statement of seedStartStatements()) {
      started.prepare(statement.sql).run(...statement.params)
    }
    expect(seedIncomplete(queryOf(started))).toBe(true)
    started.close()
    const seeded = seededDatabase()
    expect(seedIncomplete(queryOf(seeded))).toBe(false)
    seeded.close()
    // A D1 holding a catalog but no seed run (the v1 import left one before #315) is served as it is.
    const imported = migratedDatabase()
    imported
      .prepare('INSERT INTO publication_state (id,version,checksum) VALUES (1,0,?)')
      .run('imported')
    expect(seedIncomplete(queryOf(imported))).toBe(false)
    imported.close()
  })

  it('writes the same rows on every run, with no clock of its own', () => {
    expect(JSON.stringify(seedStartStatements())).toBe(JSON.stringify(seedStartStatements()))
    expect(JSON.stringify(fixtureSeedImages())).toBe(JSON.stringify(fixtureSeedImages()))
    const first = seededDatabase()
    const second = seededDatabase()
    try {
      expect(allRows(second)).toEqual(allRows(first))
      // A column left to a CURRENT_TIMESTAMP default would hold today, after SEED_NOW, and
      // differ between runs on different days.
      const later: string[] = []
      for (const table of applicationTableNames) {
        for (const column of applicationColumnInventory[table] as readonly string[]) {
          if (!/_at$/u.test(column)) continue
          const [row] = first
            .prepare(
              `SELECT COUNT(*) AS later FROM ${table} WHERE ${column} IS NOT NULL AND
                CASE typeof(${column}) WHEN 'integer' THEN ${column} > ? ELSE ${column} > ? END`
            )
            .all(Date.parse(SEED_NOW), SEED_NOW)
          if (Number(row?.later) > 0) later.push(`${table}.${column}`)
        }
      }
      expect(later).toEqual([])
    } finally {
      first.close()
      second.close()
    }
  })

  it('names no real product, domain, or person', () => {
    const strings = [
      ...fixtureSeedStatements().flatMap(statement => statement.params),
      ...fixtureSeedImages().map(image => image.sourceUrl)
    ].filter((value): value is string => typeof value === 'string')
    const hosts = strings.flatMap(value =>
      [...value.matchAll(/https?:\/\/([^/\s"]+)/gu)].map(match => match[1] ?? '')
    )
    expect(hosts.length).toBeGreaterThan(0)
    expect(hosts.filter(host => !host.endsWith('.test'))).toEqual([])
    expect(new URL(SEED_MEDIA_ORIGIN).hostname.endsWith('.test')).toBe(true)
    const emails = strings.flatMap(value => value.match(/[^\s@"]+@[^\s@"]+/gu) ?? [])
    expect(emails.length).toBeGreaterThan(0)
    expect(emails.filter(email => !email.endsWith('@example.com'))).toEqual([])
    expect(fixtureSeedListings().filter(listing => !listing.name.startsWith('Fixture '))).toEqual(
      []
    )
    expect(Object.values(seedUsers).filter(user => !user.name.startsWith('Fixture '))).toEqual([])
  })
})

describe('pnpm db:seed:local refuses anything but local state', () => {
  it('resets only a canonical local D1 state root', () => {
    const state = temporaryDirectory()
    const root = join(state, 'drizzle', 'best-serp-co')
    expect(assertResettableStateRoot(root)).toBe(root)
    for (const refused of [
      '/',
      resolve('.'),
      state,
      join(state, 'best-serp-co'),
      join(state, 'drizzle'),
      join(state, 'other', 'best-serp-co'),
      '/drizzle/best-serp-co'
    ]) {
      expect(() => assertResettableStateRoot(refused), refused).toThrow(/Refusing to reset/u)
    }
    mkdirSync(join(root, 'v3', 'd1'), { recursive: true })
    writeFileSync(join(root, 'v3', 'd1', 'db.sqlite'), '')
    writeFileSync(join(state, 'drizzle', 'kept.txt'), 'kept')
    resetLocalState(root)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(state, 'drizzle', 'kept.txt'))).toBe(true)
    expect(() => resetLocalState(state)).toThrow(/Refusing to reset/u)
    expect(existsSync(state)).toBe(true)
  })

  it('resets a state root only inside this checkout or the temp directory (#316 review)', () => {
    // The checkout's default state, and a worktree's runtime state, are inside the checkout.
    const inCheckout = resolve('.wrangler/drizzle-state/best-serp-co')
    expect(assertResettableStateRoot(inCheckout)).toBe(inCheckout)
    const runtime = resolve('.runtime/feature/d1/drizzle/best-serp-co')
    expect(assertResettableStateRoot(runtime)).toBe(runtime)
    expect(() => assertResettableStateRoot(resolve('.wrangler/other/best-serp-co'))).toThrow(
      /Refusing to reset/u
    )
    // A stale HARNESS_D1_STATE_DIRECTORY or runtime manifest pointing elsewhere is refused.
    expect(() => assertResettableStateRoot(resolve('../elsewhere/drizzle/best-serp-co'))).toThrow(
      /inside this checkout or the system temp directory/u
    )
    // So is one that leaves through a symlink.
    const checkout = temporaryDirectory()
    const temporary = temporaryDirectory()
    const outside = temporaryDirectory()
    const bases = { repositoryRoot: checkout, temporaryRoot: temporary }
    const victim = join(outside, 'drizzle', 'best-serp-co')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'keep.txt'), 'kept')
    symlinkSync(outside, join(checkout, 'link'))
    const escaping = join(checkout, 'link', 'drizzle', 'best-serp-co')
    expect(() => resetLocalState(escaping, bases)).toThrow(/Refusing to reset/u)
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
    expect(() => assertResettableStateRoot(victim, bases)).toThrow(/Refusing to reset/u)
    const inside = join(checkout, 'state', 'drizzle', 'best-serp-co')
    const inTemporary = join(temporary, 'state', 'drizzle', 'best-serp-co')
    expect(assertResettableStateRoot(inside, bases)).toBe(inside)
    expect(assertResettableStateRoot(inTemporary, bases)).toBe(inTemporary)
  })

  it('ignores a temp directory that holds the checkout or the home directory (#313)', () => {
    const home = temporaryDirectory()
    const checkout = join(home, 'checkout')
    mkdirSync(checkout)
    const inHome = join(home, 'x', 'drizzle', 'best-serp-co')
    const inCheckout = join(checkout, 'state', 'drizzle', 'best-serp-co')
    // TMPDIR=/ (or the home directory) would make every state root below it resettable.
    for (const temporaryRoot of ['/', home]) {
      const bases = { homeDirectory: home, repositoryRoot: checkout, temporaryRoot }
      expect(() => assertResettableStateRoot(inHome, bases), temporaryRoot).toThrow(
        /Refusing to reset/u
      )
      expect(assertResettableStateRoot(inCheckout, bases)).toBe(inCheckout)
    }
    // A temp directory beside them still counts.
    const temporary = temporaryDirectory()
    const inTemporary = join(temporary, 'drizzle', 'best-serp-co')
    expect(
      assertResettableStateRoot(inTemporary, {
        homeDirectory: home,
        repositoryRoot: checkout,
        temporaryRoot: temporary
      })
    ).toBe(inTemporary)
  })

  it('refuses a remote, staging, or production Worker config before touching state', () => {
    const directory = temporaryDirectory()
    const write = (name: string, config: Record<string, unknown>) => {
      const path = join(directory, `${name}.jsonc`)
      writeFileSync(path, JSON.stringify(config))
      return path
    }
    expect(() => assertLocalSeedTarget(write('local', localConfig()), {})).not.toThrow()
    expect(() => assertLocalSeedTarget()).not.toThrow()
    // A Wrangler environment is never the seed's target (#313).
    expect(() =>
      assertLocalSeedTarget(write('local-env', localConfig()), { CLOUDFLARE_ENV: 'staging' })
    ).toThrow(/CLOUDFLARE_ENV=staging/u)
    const database = (change: Record<string, unknown>) => {
      const config = localConfig()
      const [binding] = config.d1_databases as Array<Record<string, unknown>>
      config.d1_databases = [{ ...binding, ...change }]
      return config
    }
    expect(() =>
      assertLocalSeedTarget(
        write('production', database({ database_id: project.remote.production.databaseId }))
      )
    ).toThrow(/non-local, staging, or production D1 identity/u)
    expect(() => assertLocalSeedTarget(write('remote-d1', database({ remote: true })))).toThrow(
      /remote binding: DB/u
    )
    const remoteBucket = localConfig()
    remoteBucket.r2_buckets = [
      { binding: 'MEDIA', bucket_name: project.local.media.bucket, remote: true }
    ]
    expect(() => assertLocalSeedTarget(write('remote-r2', remoteBucket))).toThrow(
      /remote binding: MEDIA/u
    )
    const staging = localConfig()
    staging.vars = { D1_RUNTIME_ENV: 'staging', MEDIA_BASE_URL: project.local.media.baseUrl }
    expect(() => assertLocalSeedTarget(write('staging', staging))).toThrow(/dedicated local/u)
  })

  it('refuses CLOUDFLARE_ENV in the media seed the e2e media server runs directly (#313 review)', async () => {
    const { withLocalPlatform } = await import('./seed-local-media')
    const previous = process.env.CLOUDFLARE_ENV
    process.env.CLOUDFLARE_ENV = 'staging'
    let ran = false
    try {
      await expect(
        withLocalPlatform(async () => {
          ran = true
        })
      ).rejects.toThrow(/CLOUDFLARE_ENV=staging/u)
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARE_ENV
      else process.env.CLOUDFLARE_ENV = previous
    }
    expect(ran).toBe(false)
  })

  it('takes no target arguments', async () => {
    for (const args of [
      ['seed', '--remote'],
      ['seed', '--env', 'production'],
      ['seed', 'best-serp-co-production']
    ]) {
      await expect(runLocalD1Command(args), args.join(' ')).rejects.toThrow(/Unexpected arguments/u)
    }
    await expect(runLocalD1Command(['seed', '--site', 'best.serp.co'])).rejects.toThrow(
      /no longer take --site/u
    )
  })
})
