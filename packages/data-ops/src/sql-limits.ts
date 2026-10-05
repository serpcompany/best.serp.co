/**
 * Textual checks of SQL against D1's statement limits (serpcompany/best.serp.co#77), for tests
 * and the architecture guard. node:sqlite does not apply D1's limits and Wrangler-local D1
 * (workerd) does not enforce the 32-argument function limit, so the test helpers
 * (`test-support.ts`, `plan-test-support.ts`, the publisher and workerd D1 tests) run every
 * statement through `assertD1StatementLimits`.
 *
 * D1 limits (https://developers.cloudflare.com/d1/platform/limits/): 100 bound parameters,
 * 100,000-byte statements, 32 function arguments, 50-byte LIKE/GLOB patterns. Wrangler-local
 * D1 also enforces 5 terms per compound SELECT and an expression depth of 100.
 */
export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_MAX_STATEMENT_BYTES = 100_000
export const D1_MAX_FUNCTION_ARGUMENTS = 32
export const D1_MAX_COMPOUND_SELECT_TERMS = 5
export const D1_MAX_PATTERN_BYTES = 50

const encoder = new TextEncoder()

/**
 * String literals, double-quoted identifiers, and comments, matched in one left-to-right pass
 * so that a quote inside a comment (or a comment marker inside a string) cannot hide code.
 */
const LITERAL_IDENTIFIER_OR_COMMENT =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/gu

/** `sql` with string literals emptied (`''`) and comments blanked; identifiers are kept. */
export function stripSqlLiteralsAndComments(sql: string): string {
  return sql.replace(LITERAL_IDENTIFIER_OR_COMMENT, match => {
    if (match.startsWith("'")) return "''"
    if (match.startsWith('"')) return match
    return ' '
  })
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`
/**
 * A column (optionally table-qualified) compared with the identical column text. The left
 * side may not end a larger expression and the right side may not continue into one, so
 * `"attempts" = "attempts" + 1` and `x + c = c` are not matches; a trailing `COLLATE` is.
 */
const SELF_COMPARISON = new RegExp(
  String.raw`(?<![\w$."]|[-+*/%&|]\s*)(${IDENTIFIER}(?:\.${IDENTIFIER})?)\s*(?:==|=|!=|<>|\bIS(?:\s+NOT)?\b)\s*\1(?![\w$."(]|\s*[-+*/%&|<>=!])`,
  'iu'
)

/**
 * The first place where `sql` compares a column with itself, or null. Such a predicate is
 * always true (or NULL) and usually means a column meant for an outer query resolved to the
 * inner table: Drizzle writes columns unqualified in single-table queries, which turned
 * `admin_allowlist.email = users.email` into `"email" = "email"` (#78).
 *
 * Known limits of this textual check. Not flagged: parenthesized sides (`"c" = ("c")`), mixed
 * qualification (`"t"."c" = "c"`), an alias compared with its table name, function-wrapped
 * sides (`lower(c) = lower(c)`), backtick or bracket quoting (Drizzle does not emit them), and
 * `IS NOT DISTINCT FROM`. Flagged although not a column comparison: `NULL IS NULL`,
 * `TRUE = TRUE`, and a no-op `DO UPDATE SET c = c`; none of these appears in the SQL here.
 */
export function findSelfComparison(sql: string): string | null {
  return SELF_COMPARISON.exec(stripSqlLiteralsAndComments(sql))?.[0] ?? null
}

/** Words that precede a parenthesis without being a function call. */
const NON_FUNCTION_WORDS = new Set([
  'AND',
  'AS',
  'CHECK',
  'CONFLICT',
  'EXISTS',
  'FILTER',
  'FROM',
  'IN',
  'INTO',
  'IS',
  'JOIN',
  'MATERIALIZED',
  'KEY',
  'NOT',
  'ON',
  'OR',
  'OVER',
  'SELECT',
  'SET',
  'THEN',
  'UNIQUE',
  'USING',
  'VALUES',
  'WHEN',
  'WHERE',
  'ELSE',
  'RETURNING'
])
/** Words after which an identifier and a parenthesis name a table or index, not a function. */
const TABLE_CONTEXT_WORDS = new Set(['INTO', 'TABLE', 'INDEX', 'REFERENCES', 'ON', 'EXISTS'])

/** The function call with the most arguments in `sql` (top-level commas + 1), or null. */
export function maxFunctionArguments(sql: string): { count: number; name: string } | null {
  const code = stripSqlLiteralsAndComments(sql)
  const call = /([A-Za-z_][\w$]*)\s*\(/gu
  let widest: { count: number; name: string } | null = null
  for (let match = call.exec(code); match; match = call.exec(code)) {
    const name = match[1] ?? ''
    if (NON_FUNCTION_WORDS.has(name.toUpperCase())) continue
    const before = /([A-Za-z_]+)\s*$/u.exec(code.slice(0, match.index))?.[1]?.toUpperCase()
    if (before && TABLE_CONTEXT_WORDS.has(before)) continue
    let depth = 0
    let commas = 0
    let empty = true
    for (let index = match.index + match[0].length; index < code.length; index++) {
      const character = code[index]
      if (character === '(') depth++
      else if (character === ')') {
        if (depth === 0) break
        depth--
      } else if (character === ',' && depth === 0) commas++
      else if (!/\s/u.test(character ?? '')) empty = false
    }
    const count = empty && commas === 0 ? 0 : commas + 1
    if (!widest || count > widest.count) widest = { count, name }
  }
  return widest
}

/** Terms of the widest compound SELECT, counted conservatively over the whole statement. */
export function compoundSelectTerms(sql: string): number {
  const operators = stripSqlLiteralsAndComments(sql).match(/\b(?:UNION|INTERSECT|EXCEPT)\b/giu)
  return (operators?.length ?? 0) + 1
}

/** Literal LIKE/GLOB patterns longer than D1's 50 bytes. */
export function oversizedPatternLiterals(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/gu, ' ')
  const patterns = withoutComments.matchAll(/\b(?:LIKE|GLOB)\s+'((?:[^']|'')*)'/giu)
  return [...patterns]
    .map(match => (match[1] ?? '').replaceAll("''", "'"))
    .filter(pattern => encoder.encode(pattern).length > D1_MAX_PATTERN_BYTES)
}

/** Every D1 limit `sql` (with `params` bound) would exceed, as readable violations. */
export function d1StatementLimitViolations(sql: string, params: readonly unknown[] = []): string[] {
  const violations: string[] = []
  const bytes = encoder.encode(sql).length
  if (bytes > D1_MAX_STATEMENT_BYTES) violations.push(`statement is ${bytes} bytes`)
  const numbered = [...sql.matchAll(/\?(\d+)/gu)].map(match => Number(match[1]))
  const parameters = Math.max(params.length, ...numbered, 0)
  if (parameters > D1_MAX_BOUND_PARAMETERS) violations.push(`${parameters} bound parameters`)
  const widest = maxFunctionArguments(sql)
  if (widest && widest.count > D1_MAX_FUNCTION_ARGUMENTS) {
    violations.push(`${widest.name}() has ${widest.count} arguments`)
  }
  const terms = compoundSelectTerms(sql)
  if (terms > D1_MAX_COMPOUND_SELECT_TERMS) violations.push(`${terms} compound SELECT terms`)
  for (const pattern of oversizedPatternLiterals(sql)) {
    violations.push(`LIKE/GLOB pattern of ${encoder.encode(pattern).length} bytes`)
  }
  const selfComparison = findSelfComparison(sql)
  if (selfComparison) violations.push(`column compared with itself (${selfComparison}) (#78)`)
  return violations
}

/**
 * Throws when `sql` would exceed a D1 statement limit or compares a column with itself. The
 * SQLite and workerd test helpers call it for every statement they run.
 */
export function assertD1StatementLimits(sql: string, params: readonly unknown[] = []): void {
  const violations = d1StatementLimitViolations(sql, params)
  if (violations.length > 0) {
    throw new Error(
      `SQL exceeds a D1 limit or compares a column with itself: ${violations.join('; ')}. SQL: ${sql.slice(0, 2000)}`
    )
  }
}
