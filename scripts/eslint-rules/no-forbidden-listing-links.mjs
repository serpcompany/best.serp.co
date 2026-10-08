const PROTECTED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.xml'
])

export const FORBIDDEN_LISTING_LINK_PATTERN = /\bhttps?:\/\/help\.serp\.co\/en(?:\/|(?=$)|[?#])/gi

function normalizePath(filename) {
  const normalized = filename.replace(/\\/g, '/')
  const cwd = process.cwd().replace(/\\/g, '/')

  if (normalized.startsWith(`${cwd}/`)) {
    return normalized.slice(cwd.length + 1)
  }

  const repoMarker = '/json-directory/'
  const repoIndex = normalized.lastIndexOf(repoMarker)
  if (repoIndex !== -1) {
    return normalized.slice(repoIndex + repoMarker.length)
  }

  return normalized.replace(/^\.\//, '')
}

function hasProtectedExtension(filename) {
  return PROTECTED_EXTENSIONS.has(filename.match(/\.[^.]+$/)?.[0] ?? '')
}

/**
 * The files `pnpm lint:forbidden-links` checks by default. Each must match at least one file
 * (`no-forbidden-listing-links.test.ts`): a pattern left behind by a move would otherwise pass
 * on nothing (#172).
 */
export const DEFAULT_LINK_LINT_PATTERNS = [
  'apps/*/src/**/*.{js,jsx,md,mdx,mjs,ts,tsx}',
  'apps/*/public/**/*.{html,json,js,txt,xml}',
  'apps/web/content/**/*.{json,jsonc,md,mdx}'
]

export function isProtectedListingSurface(filename) {
  const path = normalizePath(filename)

  if (!hasProtectedExtension(path)) {
    return false
  }

  return (
    path.startsWith('apps/') ||
    path.startsWith('apps/web/content/')
  )
}

export const preserveTextLinesProcessor = {
  postprocess(messageLists) {
    return messageLists.flat()
  },
  preprocess(text) {
    return [
      text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => `// ${line}`)
        .join('\n')
    ]
  },
  supportsAutofix: false
}

const noForbiddenListingLinks = {
  meta: {
    docs: {
      description:
        'Disallow Help Center links from listing, product, directory, and rendered page sources.'
    },
    messages: {
      forbiddenListingLink:
        'Do not link to {{url}} from listing/product/directory pages. Use a product-specific support or issue link instead.'
    },
    schema: [],
    type: 'problem'
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()

    if (!isProtectedListingSurface(filename)) {
      return {}
    }

    return {
      Program(node) {
        const sourceCode = context.sourceCode ?? context.getSourceCode()
        const text = sourceCode.getText()
        const pattern = new RegExp(FORBIDDEN_LISTING_LINK_PATTERN)

        for (const match of text.matchAll(pattern)) {
          const index = match.index ?? 0
          const url = match[0]
          const loc = sourceCode.getLocFromIndex(index)

          context.report({
            data: { url },
            loc,
            messageId: 'forbiddenListingLink',
            node
          })
        }
      }
    }
  }
}

export default noForbiddenListingLinks
