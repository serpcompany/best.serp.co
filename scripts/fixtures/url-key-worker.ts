import { urlKey } from '../../apps/web/src/lib/url-key'

/**
 * Test fixture for `scripts/d1-workerd-plans.test.ts`: runs `urlKey()` (and so the Public Suffix
 * List from `tldts`) inside workerd, the runtime the submission intake uses. POST a JSON array of
 * websites; the answer is their keys in the same order.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const websites = (await request.json()) as string[]
    return Response.json(websites.map(website => urlKey(website)))
  }
}
