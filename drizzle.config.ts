import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  out: './d1/drizzle',
  schema: './packages/data-ops/src/schema.ts',
  strict: true,
  verbose: true
})
