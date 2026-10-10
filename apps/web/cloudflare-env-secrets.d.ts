/**
 * The Worker's secrets and local-only variables. `wrangler.jsonc` doesn't list them, so
 * `pnpm cf-typegen` can't see them (#228); this merges them into the generated `CloudflareEnv`.
 */
interface CloudflareEnv {
  /** Worker secret on staging and production; `apps/web/.dev.vars` locally (docs/development.md). */
  BETTER_AUTH_SECRET?: string
  /**
   * `on` turns orders (#68) on for a local Worker while `features.orders` is off
   * (`src/lib/billing/flags.ts`; unused since #133 turned the flag on). Ignored anywhere but local.
   */
  LOCAL_ORDERS?: string
  /** A local Worker only: the port of the end-to-end suite's mocked Stripe API on 127.0.0.1. */
  LOCAL_STRIPE_MOCK_PORT?: string
  /** Worker secret (#68): Stripe's secret key, test mode on staging and live in production. */
  STRIPE_SECRET_KEY?: string
  /** Worker secret (#68): the signing secret of the `/api/billing/webhook/` endpoint. */
  STRIPE_WEBHOOK_SECRET?: string
  /** Worker secret: the useSend API key (staging and production; local logs mail). */
  USESEND_API_KEY?: string
}
