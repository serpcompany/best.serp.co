/**
 * ARCHIVED (serpcompany/best.serp.co#315): the test of `pnpm db:import:local` and the import parity
 * half of `pnpm db:verify:local`, cut from `scripts/d1-drizzle-local.test.ts` as it was before
 * #315 (it used that file's `runLocal`, `failingLocalStderr`, `executeLocal`, and
 * `temporaryDirectory` helpers). History only: not built, linted, or run.
 */
function mutateCanonicalState(stateDirectory: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      project.local.databaseName,
      '--command',
      "UPDATE listing_resource_links SET label=label || ' tampered' WHERE id=(SELECT id FROM listing_resource_links ORDER BY id LIMIT 1)",
      '--local',
      '--persist-to',
      resolve(stateDirectory, 'drizzle', 'best-serp-co'),
      '--config',
      project.wranglerConfigPath
    ],
    { stdio: 'ignore' }
  )
}

describe('local D1 import (archived)', () => {
  it.runIf(
    existsSync(resolve(project.artifact.batchDirectory, '0001.sql')) ||
      existsSync(resolve(project.artifact.compressedSqlPath))
  )(
    'bootstraps the reviewed initial artifact with exact repeatable parity',
    () => {
      const stateDirectory = temporaryDirectory('best-serp-co-bootstrap-')
      runLocal('migrate', stateDirectory)
      runLocal('import', stateDirectory)
      expect(runLocal('verify', stateDirectory)).toContain('Verified local D1 publication')
      expect(runLocal('import', stateDirectory)).toContain('import is a no-op')
      expect(runLocal('verify', stateDirectory)).toContain('Verified local D1 publication')
      // Accounts created at runtime (sign-ins, code limits) are outside bootstrap parity.
      executeLocal(
        stateDirectory,
        "INSERT INTO users (id, name, email, email_verified) VALUES ('u1', '', 'a@example.com', 1); INSERT INTO auth_rate_limit_hits (bucket, hit_at) VALUES ('b', 1)"
      )
      // The count comes from the table inventory, so a migration that adds a table cannot
      // leave a stale number here (#77).
      const parityTables = `${parityTableNames.length}-table`
      expect(runLocal('verify', stateDirectory)).toContain(`exact ${parityTables} snapshot`)
      mutateCanonicalState(stateDirectory)
      // The tampered table, and nothing else, must fail parity (not a crash or a missing report).
      expect(failingLocalStderr('verify', stateDirectory)).toContain(
        `Local D1 exact ${parityTables} bootstrap parity failed: listing_resource_links.`
      )
    },
    240_000
  )
})
