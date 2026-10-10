import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertD1Compatible, d1CompatViolations } from './d1-compat'
import { buildPublicationPlan, GUARD_FAILURE, parseManifest } from './d1-publisher.ts'

/** Files other tests write and remove while the suite runs. */
const transientFiles = new Set(['remote-publisher-media-test.yaml', 'remote-publisher-test.yaml'])

describe('D1 compatibility of generated statements (#95 release blocker, SQLITE_AUTH)', () => {
  it.each([
    ['PRAGMA foreign_keys = ON', 'PRAGMA'],
    ['  pragma defer_foreign_keys=on', 'PRAGMA'],
    ['CREATE TEMP TABLE publication_guard (valid INTEGER)', 'temporary object'],
    ['CREATE TEMPORARY TABLE g (v INTEGER)', 'temporary object'],
    ['INSERT INTO temp.g VALUES (1)', 'temp schema'],
    ['SELECT * FROM sqlite_temp_master', 'temp schema'],
    ['BEGIN IMMEDIATE', 'transaction control'],
    ['COMMIT', 'transaction control'],
    ['SAVEPOINT s', 'transaction control'],
    ["ATTACH DATABASE 'x.db' AS x", 'ATTACH or DETACH'],
    ['VACUUM', 'VACUUM'],
    ["SELECT load_extension('x')", 'load_extension'],
    ['DELETE FROM sqlite_sequence', 'write to a sqlite_* table'],
    ['SELECT * FROM _cf_KV', 'D1 internal _cf_ table']
  ])('flags %s', (sql, violation) => {
    expect(d1CompatViolations(sql)).toContain(violation)
  })

  it('reads code, not data: literals and comments never trip it', () => {
    expect(
      d1CompatViolations(
        "SELECT CASE WHEN x='begin; pragma; create temp table' THEN 1 ELSE json_extract('', '$') END /* temp. savepoint */"
      )
    ).toEqual([])
    expect(d1CompatViolations('SELECT name FROM sqlite_master')).toEqual([])
    expect(d1CompatViolations("UPDATE listings SET content='VACUUM' WHERE id=?")).toEqual([])
  })

  it('refuses a plan with a forbidden statement before anything is sent', () => {
    expect(() => assertD1Compatible([{ query: 'CREATE TEMP TABLE g (v INTEGER)' }])).toThrow(
      /D1 refuses temporary object/u
    )
  })

  it('every committed manifest plans only statements D1 accepts', () => {
    const directory = resolve('d1/publications')
    const files = readdirSync(directory).filter(
      file => /\.ya?ml$/u.test(file) && !transientFiles.has(file)
    )
    expect(files.length).toBeGreaterThanOrEqual(10)
    const actions = new Set<string>()
    for (const file of files) {
      const source = readFileSync(resolve(directory, file), 'utf8')
      const manifest = parseManifest(source)
      for (const operation of manifest.operations) actions.add(operation.action)
      const live =
        manifest.concurrency === 'rows' ? { checksum: 'a'.repeat(64), version: 7 } : undefined
      const plan = buildPublicationPlan(manifest, source, '2026-10-06T00:00:00.000Z', live)
      for (const statement of plan.statements) {
        expect(d1CompatViolations(statement.query), `${file}: ${statement.query}`).toEqual([])
      }
      // The guards are assertion SELECTs, not a table.
      expect(plan.statements.some(statement => statement.query.includes(GUARD_FAILURE))).toBe(true)
    }
    expect([...actions].sort()).toEqual([
      'category-unpublish',
      'listing-categories-add',
      'listing-categories-remove',
      'listing-claim-hold-add',
      'listing-content-remove-suffix',
      'listing-media-update',
      'listing-slug-redirect',
      'listing-unpublish'
    ])
  })
})
