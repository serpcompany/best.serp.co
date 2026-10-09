import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareWithBaseline, literalColors } from './theme-color-guard'

/**
 * Components style only through the theme tokens (serp's shadcn-first standard, #183): no hex,
 * rgb() or hsl() literals and no Tailwind palette colors (`bg-red-500`, `text-white`) in
 * `apps/web/src`. Use the tokens (`bg-destructive`, `text-muted-foreground`) instead.
 *
 * Each file's count is a ratchet: `COLOR_BASELINE` holds it, and it may only go down. A change
 * that adds a palette class fails; a change that removes some must lower the file's number (or
 * delete the entry at zero), so the count never creeps back up.
 */

/** Files that may use literal colors, each with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  'apps/web/src/app/globals.css': 'defines the theme tokens themselves',
  'apps/web/src/lib/email/emails/layout.ts':
    'email clients ignore CSS variables, so the email palette is literal hex'
}

/** Stock shadcn components (#175): they stay as the registry ships them (#186 replaces them). */
const STOCK_UI = [
  'accordion',
  'alert',
  'alert-dialog',
  'aspect-ratio',
  'avatar',
  'badge',
  'breadcrumb',
  'button',
  'card',
  'checkbox',
  'collapsible',
  'command',
  'dialog',
  'drawer',
  'dropdown-menu',
  'empty',
  'field',
  'input',
  'input-group',
  'input-otp',
  'item',
  'label',
  'navigation-menu',
  'pagination',
  'popover',
  'progress',
  'radio-group',
  'scroll-area',
  'select',
  'separator',
  'sheet',
  'sidebar',
  'skeleton',
  'sonner',
  'spinner',
  'table',
  'tabs',
  'textarea',
  'toggle',
  'toggle-group',
  'tooltip'
].map(name => `apps/web/src/components/ui/${name}.tsx`)

/**
 * Each file's literal-color count, which may only go down. Empty since the shared shell (#256)
 * replaced the hand-built overlays.
 */
const COLOR_BASELINE: Readonly<Record<string, number>> = {}

function sourceFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web/src'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(file => /\.(?:css|ts|tsx)$/u.test(file) && !/\.test\.tsx?$/u.test(file))
    .filter(file => existsSync(file))
}

describe('theme colors only (#183)', () => {
  it('finds palette classes, palette variables, hex values and color functions', () => {
    expect(
      literalColors(
        [
          '<div className="bg-red-500 hover:text-zinc-400/80 border-t-amber-300 ring-offset-white" />',
          "const accent = { ink: '#09090b', bright: '#fff', line: '1px solid #e5e7eb' }",
          'ctx.fillStyle = `rgba(' + '$' + '{rgb}, 1)`',
          'style={{ color: hsl(240 5% 92%) }}',
          '<p className="shadow-[0_0_0_1px_#000] bg-[linear-gradient(90deg,#fff,#000)]" />',
          '<p className="inset-shadow-sky-500 drop-shadow-black/50 text-shadow-white" />',
          '<p className="bg-(--color-red-500) text-[var(--color-amber-600)]" />',
          "const line = { border: '1px solid #000000', background: 'linear-gradient(#fff, #000)' }",
          '<p className="bg-[linear-gradient(to_right,#8080800a_1px,transparent_1px)] shadow-[0_0_0_1px_#fff_inset]" />'
        ].join('\n'),
        'probe.tsx'
      )
    ).toEqual([
      '1: palette class bg-red-500',
      '1: palette class text-zinc-400/80',
      '1: palette class border-t-amber-300',
      '1: palette class ring-offset-white',
      '2: hex color #09090b',
      '2: hex color #fff',
      '2: hex color #e5e7eb',
      '3: color function rgba(',
      '4: color function hsl(',
      '5: hex color #000',
      '5: hex color #fff',
      '5: hex color #000',
      '6: palette class inset-shadow-sky-500',
      '6: palette class drop-shadow-black/50',
      '6: palette class text-shadow-white',
      '7: palette variable --color-red-500',
      '7: palette variable --color-amber-600',
      '8: hex color #000000',
      '8: hex color #fff',
      '9: hex color #8080800a',
      '9: hex color #fff'
    ])
    expect(literalColors('a {\n  /* #fff */\n  border: 1px solid #ccc;\n}', 'probe.css')).toEqual([
      '3: hex color #ccc'
    ])
  })

  it('ignores tokens, anchors, issue numbers and comments, and keeps line numbers', () => {
    expect(
      literalColors(
        [
          '// Fixed in #155; see #68.',
          '/* The amber badge (#64) */',
          '/** Never `bg-red-500`. */',
          'const a = 1 /* #fff */',
          "const href = '#faqs'",
          "const fail = () => { throw new Error('Retry later (#68), see #155, #183.') }",
          'const page = (',
          '  <>',
          '    <p className="bg-destructive text-muted-foreground border-border ring-ring" />',
          '    <div className="text-balance bg-background/80 from-primary" />',
          '    <p>// not a comment, and #155 in copy</p>',
          '    <p>Badge or payment only (#130, #133).</p>',
          '    {/* bg-red-500 */}',
          '  </>',
          ')'
        ].join('\n'),
        'probe.tsx'
      )
    ).toEqual([])
    // A `/*` in a string isn't a comment, and a blank line before `//` keeps its line.
    expect(
      literalColors(
        [
          "const accept = 'image/*'",
          "const red = 'bg-red-500'",
          '',
          '// a comment',
          "const white = 'text-white'",
          '/* the end */',
          '/** bg-red-500 #fff */'
        ].join('\n'),
        'probe.tsx'
      )
    ).toEqual(['2: palette class bg-red-500', '5: palette class text-white'])
  })

  it('fails a file over its count, and a count or entry left above the code', () => {
    const uses = {
      'a.tsx': ['1: palette class bg-red-500', '2: hex color #fff'],
      'b.tsx': ['3: x']
    }
    expect(compareWithBaseline(uses, { 'a.tsx': 2, 'b.tsx': 1 })).toEqual({ over: [], stale: [] })
    expect(compareWithBaseline(uses, { 'a.tsx': 1, 'b.tsx': 1 })).toEqual({
      over: [
        'a.tsx: 2 literal colors (baseline 1)\n  1: palette class bg-red-500\n  2: hex color #fff'
      ],
      stale: []
    })
    expect(compareWithBaseline(uses, { 'a.tsx': 2 }).over).toEqual([
      'b.tsx: 1 literal colors (baseline 0)\n  3: x'
    ])
    expect(compareWithBaseline(uses, { 'a.tsx': 3, 'b.tsx': 1 }).stale).toEqual([
      'a.tsx: 2 (baseline 3)'
    ])
    // A file that was cleaned up or deleted still has an entry.
    expect(compareWithBaseline(uses, { 'a.tsx': 2, 'b.tsx': 1, 'gone.tsx': 4 }).stale).toEqual([
      'gone.tsx: 0 (baseline 4)'
    ])
  })

  it('keeps every file at or under its recorded count, and records every decrease', () => {
    const allowed = new Set([...Object.keys(ALLOWED), ...STOCK_UI])
    const uses: Record<string, string[]> = {}
    for (const file of sourceFiles()) {
      if (allowed.has(file)) continue
      const found = literalColors(readFileSync(file, 'utf8'), file)
      if (found.length > 0) uses[file] = found
    }
    const { over, stale } = compareWithBaseline(uses, COLOR_BASELINE)
    expect(
      over,
      'Style with the theme tokens (bg-destructive, text-muted-foreground, border-border, …), not palette classes or literal colors. See the shadcn-first standard.'
    ).toEqual([])
    expect(
      stale,
      'A file uses fewer literal colors than COLOR_BASELINE records: lower its number in scripts/theme-color-guard.test.ts (delete the entry at 0), so the count cannot creep back up.'
    ).toEqual([])
  })

  it('keeps components/ui/ to exactly the stock shadcn files (#238)', () => {
    const files = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web/src/components/ui'],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter(file => file && existsSync(file))
    expect(
      files.sort(),
      'components/ui/ holds only stock shadcn files: put a site component under its area (components/<area>/), or list a newly added registry component in STOCK_UI.'
    ).toEqual([...STOCK_UI].sort())
  })

  it('names only files that exist, and gives each allowance a reason', () => {
    for (const file of [...Object.keys(ALLOWED), ...STOCK_UI, ...Object.keys(COLOR_BASELINE)]) {
      expect(existsSync(file), file).toBe(true)
    }
    for (const [file, reason] of Object.entries(ALLOWED))
      expect(reason.length, file).toBeGreaterThan(10)
  })
})
