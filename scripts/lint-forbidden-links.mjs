import { existsSync, statSync } from 'node:fs'
import { ESLint } from 'eslint'
import { isProtectedListingSurface } from './eslint-rules/no-forbidden-listing-links.mjs'

const DEFAULT_PATTERNS = [
  'apps/*/app/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/components/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/lib/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/public/**/*.{html,json,js,txt,xml}',
  'packages/site-config/**/*.{js,jsx,json,jsonc,md,mdx,mjs,ts,tsx}',
  'packages/web-core/src/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'packages/content/data/**/*.{json,jsonc,md,mdx}'
]

/** Pre-rendered OpenNext assets of the web app, linted with --generated after a Worker build. */
const GENERATED_PATTERNS = ['apps/web/.open-next/assets/**/*.{html,json,js,txt,xml}']

function hasFlag(name) {
  return process.argv.includes(name)
}

function readExplicitFiles() {
  return process.argv.slice(2).filter(argument => !argument.startsWith('--'))
}

function existingProtectedFiles(paths) {
  return paths.filter(path => {
    if (!isProtectedListingSurface(path) || !existsSync(path)) {
      return false
    }

    return statSync(path).isFile()
  })
}

const explicitFiles = existingProtectedFiles(readExplicitFiles())
const targets =
  explicitFiles.length > 0
    ? explicitFiles
    : hasFlag('--generated')
      ? GENERATED_PATTERNS
      : DEFAULT_PATTERNS
const eslint = new ESLint({
  errorOnUnmatchedPattern: false,
  overrideConfigFile: 'eslint.config.mjs'
})
const results = await eslint.lintFiles(targets)
const formatter = await eslint.loadFormatter('stylish')
const output = formatter.format(results)

if (output) {
  console.log(output)
}

const hasFailures = results.some(result => result.errorCount > 0 || result.fatalErrorCount > 0)

if (hasFailures) {
  process.exitCode = 1
}
