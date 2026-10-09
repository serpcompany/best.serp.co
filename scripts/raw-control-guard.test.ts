import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rawControls } from './raw-control-guard'
import { compareWithBaseline } from './theme-color-guard'

/**
 * Components use the stock control, not a native one (serp's shadcn-first standard, #188): no raw
 * `<button>`, `<input>`, `<select>` or `<textarea>` in `apps/web/src` outside `components/ui/`.
 * Use Button, Input, Select, Textarea or Input Group instead.
 *
 * Each file's count is a ratchet, as in `theme-color-guard.test.ts`: `CONTROL_BASELINE` holds it,
 * and it may only go down.
 */

/**
 * Each file's raw-control count, which may only go down. Left: the hand-built header search,
 * mobile drawer and autocomplete, and the search input that the header and the home page's
 * search controls share. #253 removes the header search and rebuilds the shell and home page,
 * and their entries go.
 */
const CONTROL_BASELINE: Readonly<Record<string, number>> = {
  'apps/web/src/components/layout/header-search.tsx': 1,
  'apps/web/src/components/layout/mobile-drawer.tsx': 2,
  'apps/web/src/components/search/search-autocomplete.tsx': 1,
  'apps/web/src/components/search/search-input.tsx': 1
}

function componentFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web/src'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(file => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
    .filter(file => !file.startsWith('apps/web/src/components/ui/'))
    .filter(file => existsSync(file))
}

describe('stock controls only (#188)', () => {
  it('finds raw buttons, inputs, selects and textareas, opening or self-closing', () => {
    expect(
      rawControls(
        [
          'const a = (',
          '  <form>',
          '    <button type="button">Go</button>',
          '    <input value="x" />',
          '    <select><option>One</option></select>',
          '    <textarea readOnly />',
          '  </form>',
          ')'
        ].join('\n'),
        'probe.tsx'
      )
    ).toEqual(['3: <button>', '4: <input>', '5: <select>', '6: <textarea>'])
  })

  it('ignores components, member tags, comments, strings and copy', () => {
    expect(
      rawControls(
        [
          '// A raw <button> was here.',
          "const html = '<button>embed</button>'",
          'const a = (',
          '  <>',
          '    <Button>Go</Button>',
          '    <Input />',
          '    <InputGroupTextarea readOnly />',
          '    <Select.Trigger />',
          '    <p>Press the &lt;button&gt;.</p>',
          '    {/* <input /> */}',
          '  </>',
          ')'
        ].join('\n'),
        'probe.tsx'
      )
    ).toEqual([])
  })

  it('keeps every file at or under its recorded count, and records every decrease', () => {
    const uses: Record<string, string[]> = {}
    for (const file of componentFiles()) {
      const found = rawControls(readFileSync(file, 'utf8'), file)
      if (found.length > 0) uses[file] = found
    }
    const { over, stale } = compareWithBaseline(uses, CONTROL_BASELINE, 'raw controls')
    expect(
      over,
      'Use the stock component (Button, Input, Select, Textarea, Input Group, Toggle), not a native control. See the shadcn-first standard.'
    ).toEqual([])
    expect(
      stale,
      'A file has fewer raw controls than CONTROL_BASELINE records: lower its number in scripts/raw-control-guard.test.ts (delete the entry at 0), so the count cannot creep back up.'
    ).toEqual([])
  })

  it('names only files that exist', () => {
    for (const file of Object.keys(CONTROL_BASELINE)) expect(existsSync(file), file).toBe(true)
  })
})
