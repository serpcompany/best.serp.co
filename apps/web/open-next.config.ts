import { defineCloudflareConfig } from '@opennextjs/cloudflare'

export default {
  ...defineCloudflareConfig(),
  // `next build`, then one copy of each server chunk before OpenNext bundles them into the Worker
  // (scripts/dedupe-server-chunks.ts, #424). OpenNext runs it in this directory.
  buildCommand: 'pnpm build && pnpm --dir=../.. tsx scripts/dedupe-server-chunks.ts'
}
