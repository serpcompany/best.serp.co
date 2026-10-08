import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  out: './drizzle',
  schema: './src/db/schema.ts',
  strict: true,
  verbose: true
})
