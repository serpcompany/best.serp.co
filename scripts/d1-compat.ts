/**
 * What D1's remote query API accepts in a batch the publisher sends (#95 release blocker: run
 * 37471283341 failed with `not authorized: SQLITE_AUTH`). D1 runs each batch as one transaction
 * under an authorizer, so a statement that local SQLite runs can still be refused remotely:
 *
 * - temporary objects (`CREATE TEMP TABLE`, the `temp` schema): refused, which is what broke the
 *   publisher's old `publication_guard` table;
 * - `PRAGMA`: only a documented few, and only for the current transaction; a publication needs
 *   none (D1 enforces foreign keys on every connection);
 * - transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `END`): the batch
 *   is the transaction;
 * - `ATTACH`/`DETACH`, `VACUUM`, `load_extension`, writes to `sqlite_*` tables, and D1's own
 *   `_cf_*` tables.
 *
 * `d1CompatViolations` reads one statement's SQL (string literals and comments removed, so data
 * never trips it) and names every construct above it finds. The publisher refuses to plan a
 * statement with a violation, and `scripts/d1-compat.test.ts` lints every committed manifest.
 */

function code(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/gu, "''")
    .replace(/--[^\n]*/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
}

const rules: ReadonlyArray<[RegExp, string]> = [
  [/^\s*pragma\b/iu, 'PRAGMA'],
  [/\bcreate\s+(?:temp|temporary)\b/iu, 'temporary object'],
  [/\b(?:temp|temporary)\s*\./iu, 'temp schema'],
  [/\bsqlite_temp_(?:master|schema)\b/iu, 'temp schema'],
  [/^\s*(?:begin|commit|rollback|savepoint|release|end)\b/iu, 'transaction control'],
  [/\b(?:attach|detach)\s+(?:database\b|')/iu, 'ATTACH or DETACH'],
  [/^\s*vacuum\b/iu, 'VACUUM'],
  [/\bload_extension\s*\(/iu, 'load_extension'],
  [
    /\b(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from|drop\s+table|alter\s+table)\s+["`[]?sqlite_/iu,
    'write to a sqlite_* table'
  ],
  [/["`[]?\b_cf_\w*/iu, 'D1 internal _cf_ table']
]

export function d1CompatViolations(sql: string): string[] {
  const stripped = code(sql)
  return rules.flatMap(([pattern, name]) => (pattern.test(stripped) ? [name] : []))
}

/** Throws when any statement uses a construct D1's remote API refuses. */
export function assertD1Compatible(statements: ReadonlyArray<{ query: string }>): void {
  for (const statement of statements) {
    const violations = d1CompatViolations(statement.query)
    if (violations.length > 0) {
      throw new Error(
        `D1 refuses ${violations.join(', ')}: ${statement.query.replace(/\s+/gu, ' ').slice(0, 120)}`
      )
    }
  }
}
