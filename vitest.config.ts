import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * `@/` names `apps/web/src`, as in `apps/web/tsconfig.json`, so tests import app modules the way
 * the app does (#174 folded `packages/web-core` in). Tests still mock runtime-only modules.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'apps/web/src') }
  }
})
