import { existsSync, statSync } from 'node:fs'
import { ESLint } from 'eslint'
import {
  DEFAULT_LINK_LINT_PATTERNS as DEFAULT_PATTERNS,
  isProtectedListingSurface
} from './eslint-rules/no-forbidden-listing-links.mjs'

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
