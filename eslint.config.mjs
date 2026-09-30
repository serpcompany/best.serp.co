import noForbiddenListingLinks, {
  preserveTextLinesProcessor
} from './scripts/eslint-rules/no-forbidden-listing-links.mjs'

const directorySafetyPlugin = {
  processors: {
    'preserve-text-lines': preserveTextLinesProcessor
  },
  rules: {
    'no-forbidden-listing-links': noForbiddenListingLinks
  }
}

export default [
  {
    ignores: [
      '**/.devin/**',
      '**/.git/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      'tmp/**'
    ]
  },
  {
    files: ['**/*.{html,js,jsx,json,jsonc,md,mdx,mjs,ts,tsx,txt,xml}'],
    plugins: {
      directory: directorySafetyPlugin
    },
    processor: 'directory/preserve-text-lines',
    rules: {
      'directory/no-forbidden-listing-links': 'error'
    }
  }
]
