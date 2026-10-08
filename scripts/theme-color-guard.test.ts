import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Components style only through the theme tokens (serp's shadcn-first standard, #183): no hex,
 * rgb() or hsl() literals and no Tailwind palette colors (`bg-red-500`, `text-white`) in
 * `apps/web/src`. Use the tokens (`bg-destructive`, `text-muted-foreground`) instead.
 *
 * Today's uses are a ratchet: `COLOR_BASELINE` holds each file's count, which may only go
 * down. A change that adds a palette class fails; a change that removes some must lower the
 * file's number (or delete the entry at zero), so the count never creeps back up.
 */

/** Files that may use literal colors, each with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  'apps/web/src/app/globals.css': 'defines the theme tokens themselves',
  'apps/web/src/lib/email/emails/layout.ts':
    'email clients ignore CSS variables, so the email palette is literal hex',
  'apps/web/src/components/ui/animated-background.tsx': 'draws on a canvas with rgba()'
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

/** Each file's literal-color count on 2026-10-08. Lower it as a file moves to tokens. */
const COLOR_BASELINE: Readonly<Record<string, number>> = {
  'apps/web/src/app/error.tsx': 3,
  'apps/web/src/app/not-found.tsx': 3,
  'apps/web/src/components/account/account-dashboard.tsx': 3,
  'apps/web/src/components/account/listing-edit.tsx': 12,
  'apps/web/src/components/account/record.tsx': 5,
  'apps/web/src/components/account/status.tsx': 14,
  'apps/web/src/components/account/withdraw-dialog.tsx': 1,
  'apps/web/src/components/admin/admins-manager.tsx': 1,
  'apps/web/src/components/admin/listing-detail.tsx': 5,
  'apps/web/src/components/admin/orders-manager.tsx': 7,
  'apps/web/src/components/admin/preview-card-body.tsx': 3,
  'apps/web/src/components/admin/review-detail.tsx': 10,
  'apps/web/src/components/admin/status-badge.tsx': 26,
  'apps/web/src/components/auth/login-card.tsx': 3,
  'apps/web/src/components/content/mdx-components.tsx': 4,
  'apps/web/src/components/directory/directory-product-list.tsx': 8,
  'apps/web/src/components/directory/websites-search-controls.tsx': 2,
  'apps/web/src/components/layout/header-search.tsx': 1,
  'apps/web/src/components/layout/mobile-drawer.tsx': 1,
  'apps/web/src/components/search/search-autocomplete.tsx': 4,
  'apps/web/src/components/search/search-results.tsx': 14,
  'apps/web/src/components/sections/guide-card.tsx': 12,
  'apps/web/src/components/submit/badge-step.tsx': 3,
  'apps/web/src/components/submit/submit-form.tsx': 2,
  'apps/web/src/components/submit/submit-ui.tsx': 15,
  'apps/web/src/components/ui/copy-button.tsx': 9,
  'apps/web/src/components/ui/favorite-button.tsx': 12,
  'apps/web/src/components/website/website-cli-section.tsx': 11,
  'apps/web/src/components/website/website-hero.tsx': 6
}

const PREFIX =
  '(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|from|via|to|outline|divide|shadow|decoration|caret|accent|placeholder)'
const PALETTE =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)'
const patterns: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'palette class',
    new RegExp(`(?<![\\w-])${PREFIX}-${PALETTE}(?:-\\d{2,3})?(?:\\/\\d{1,3})?(?![\\w-])`, 'gu')
  ],
  // A hex color in a string or CSS value; `#155` in a comment or `(#68)` in copy is an issue.
  ['hex color', /(?<=['"`[=:]\s?)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/gu],
  ['color function', /(?<![\w-])(?:rgba?|hsla?|oklch|oklab)\(/gu]
]

/** Comments name issues (`#155`) and colors in prose; only code counts. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, comment => comment.replace(/[^\n]/gu, ' '))
    .replace(/^\s*\/\/.*$/gmu, '')
}

/** Every literal color in `source`, as `line: kind text`. */
function literalColors(source: string): string[] {
  const code = withoutComments(source)
  const uses: string[] = []
  for (const [kind, pattern] of patterns) {
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index).split('\n').length
      uses.push(`${line}: ${kind} ${match[0]}`)
    }
  }
  return uses
}

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps/web/src'], { encoding: 'utf8' })
    .split('\n')
    .filter(file => /\.(?:css|ts|tsx)$/u.test(file) && !/\.test\.tsx?$/u.test(file))
    .filter(file => existsSync(file))
}

describe('theme colors only (#183)', () => {
  it('finds palette classes, hex values and color functions, and nothing else', () => {
    expect(
      literalColors(
        [
          '<div className="bg-red-500 hover:text-zinc-400/80 border-t-amber-300 ring-offset-white" />',
          "const accent = { ink: '#09090b', bright: '#fff' }",
          'ctx.fillStyle = `rgba(' + '$' + '{rgb}, 1)`',
          'style={{ color: hsl(240 5% 92%) }}'
        ].join('\n')
      )
    ).toEqual([
      '1: palette class bg-red-500',
      '1: palette class text-zinc-400/80',
      '1: palette class border-t-amber-300',
      '1: palette class ring-offset-white',
      '2: hex color #09090b',
      '2: hex color #fff',
      '3: color function rgba(',
      '4: color function hsl('
    ])
    expect(
      literalColors(
        [
          '// Fixed in #155; see #68.',
          '/* The amber badge (#64) */',
          '<p className="bg-destructive text-muted-foreground border-border ring-ring" />',
          "throw new Error('Retry later (#68).')",
          "const href = '#faqs'",
          '<div className="text-balance bg-background/80 from-primary" />'
        ].join('\n')
      )
    ).toEqual([])
  })

  it('keeps every file at or under its recorded count, and records every decrease', () => {
    const allowed = new Set([...Object.keys(ALLOWED), ...STOCK_UI])
    const over: string[] = []
    const stale: string[] = []
    const counts: Record<string, number> = {}
    for (const file of sourceFiles()) {
      if (allowed.has(file)) continue
      const uses = literalColors(readFileSync(file, 'utf8'))
      if (uses.length > 0) counts[file] = uses.length
      const baseline = COLOR_BASELINE[file] ?? 0
      if (uses.length > baseline) {
        over.push(
          `${file}: ${uses.length} literal colors (baseline ${baseline})\n  ${uses.join('\n  ')}`
        )
      } else if (uses.length < baseline) {
        stale.push(`${file}: ${uses.length} (baseline ${baseline})`)
      }
    }
    for (const file of Object.keys(COLOR_BASELINE)) {
      if (!(file in counts) && !stale.some(entry => entry.startsWith(`${file}:`))) {
        stale.push(`${file}: 0 (baseline ${COLOR_BASELINE[file]})`)
      }
    }
    expect(
      over,
      'Style with the theme tokens (bg-destructive, text-muted-foreground, border-border, …), not palette classes or literal colors. See the shadcn-first standard.'
    ).toEqual([])
    expect(
      stale,
      'A file uses fewer literal colors than COLOR_BASELINE records: lower its number in scripts/theme-color-guard.test.ts (delete the entry at 0), so the count cannot creep back up.'
    ).toEqual([])
  })

  it('names only files that exist, and gives each allowance a reason', () => {
    for (const file of [...Object.keys(ALLOWED), ...STOCK_UI, ...Object.keys(COLOR_BASELINE)]) {
      expect(existsSync(file), file).toBe(true)
    }
    for (const [file, reason] of Object.entries(ALLOWED))
      expect(reason.length, file).toBeGreaterThan(10)
  })
})
