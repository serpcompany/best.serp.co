import ts from 'typescript'

/**
 * The scanner behind `theme-color-guard.test.ts` (#183): finds literal colors in a source file
 * and compares each file's count with its recorded baseline.
 */

const PREFIX =
  '(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|inset-ring|inset-shadow|drop-shadow|text-shadow|fill|stroke|from|via|to|outline|divide|shadow|decoration|caret|accent|placeholder)'
const PALETTE =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)'
const HEX = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\\w-])'

const patterns: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'palette class',
    new RegExp(`(?<![\\w-])${PREFIX}-${PALETTE}(?:-\\d{2,3})?(?:\\/\\d{1,3})?(?![\\w-])`, 'gu')
  ],
  // `bg-(--color-red-500)` and `var(--color-amber-600)` name the palette through its variable.
  ['palette variable', new RegExp(`--color-${PALETTE}(?:-\\d{2,3})?(?![\\w-])`, 'gu')],
  // A hex with a letter is a color wherever it stands. Copy names issues with digits (`(#68)`),
  // so a hex of 3 or 4 digits only counts where a value starts (`'#000'`, `: #000`, `_#000]`,
  // `,#000`), never after a space (`(#130, #133)`); one of 6 or 8 digits, which no issue number
  // has, counts after a space or `(` too.
  [
    'hex color',
    new RegExp(
      [
        `(?<![\\w&#])(?=#\\d*[a-fA-F])${HEX}`,
        `(?:(?<=['"\`[=:]\\s?)|(?<=[_,]))${HEX}`,
        '(?<=[\\s(])#(?:\\d{8}|\\d{6})(?![\\w-])'
      ].join('|'),
      'gu'
    )
  ],
  ['color function', /(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\(/gu]
]

/** `source` with each range blanked, newlines kept, so line numbers still hold. */
function blank(source: string, ranges: ReadonlyArray<{ end: number; pos: number }>): string {
  let result = source
  for (const { end, pos } of ranges) {
    result =
      result.slice(0, pos) + result.slice(pos, end).replace(/[^\n]/gu, ' ') + result.slice(end)
  }
  return result
}

/**
 * Comments name issues (`#155`) and colors in prose; only code counts. TypeScript's parser
 * splits the file into tokens, and the trivia before each token (whitespace and comments) is
 * blanked, so `'image/*'` in a string or `// …` in JSX text is never taken for a comment.
 */
function withoutComments(source: string, fileName: string): string {
  if (fileName.endsWith('.css')) {
    return blank(
      source,
      [...source.matchAll(/\/\*[\s\S]*?\*\//gu)].map(match => ({
        end: match.index + match[0].length,
        pos: match.index
      }))
    )
  }
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const trivia: Array<{ end: number; pos: number }> = []
  const visit = (node: ts.Node) => {
    // JSX text is copy, whitespace included. A JSDoc block is already in a token's trivia (the
    // end-of-file token's, at the end of a file), so a token is a node with no other children.
    if (node.kind === ts.SyntaxKind.JsxText || ts.isJSDoc(node)) return
    const children = node.getChildren(file).filter(child => !ts.isJSDoc(child))
    if (children.length === 0) trivia.push({ end: node.getStart(file), pos: node.pos })
    for (const child of children) visit(child)
  }
  visit(file)
  return blank(source, trivia)
}

/** Every literal color in `source` outside comments, as `line: kind text`. */
export function literalColors(source: string, fileName: string): string[] {
  const code = withoutComments(source, fileName)
  const lineOf = (index: number) => code.slice(0, index).split('\n').length
  const uses: Array<[number, string]> = []
  for (const [kind, pattern] of patterns) {
    for (const match of code.matchAll(pattern)) {
      uses.push([match.index, `${lineOf(match.index)}: ${kind} ${match[0]}`])
    }
  }
  return uses.sort(([a], [b]) => a - b).map(([, use]) => use)
}

/**
 * The ratchet: `over` lists each file with more uses than its baseline (0 when it has none),
 * with every use; `stale` lists each baseline entry above the file's count, including an entry
 * for a file that no longer has uses or no longer exists.
 */
export function compareWithBaseline(
  uses: Readonly<Record<string, readonly string[]>>,
  baseline: Readonly<Record<string, number>>
): { over: string[]; stale: string[] } {
  const over: string[] = []
  const stale: string[] = []
  for (const [file, found] of Object.entries(uses)) {
    const recorded = baseline[file] ?? 0
    if (found.length > recorded) {
      over.push(
        `${file}: ${found.length} literal colors (baseline ${recorded})\n  ${found.join('\n  ')}`
      )
    }
  }
  for (const [file, recorded] of Object.entries(baseline)) {
    const count = uses[file]?.length ?? 0
    if (count < recorded) stale.push(`${file}: ${count} (baseline ${recorded})`)
  }
  return { over, stale }
}
