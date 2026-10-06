/**
 * Site areas that later steps of #59 ship. Whatever depends on one of them (email copy and
 * links, admin navigation) reads its flag here instead of promising it early. The issue that
 * builds the area turns the flag on, and the approved wording and links come back on their own:
 * `apps/web/lib/email/emails/links.test.ts` then requires the pages they link to, and
 * `apps/web/lib/feature-copy.test.ts` keeps page copy from promising an area that is off.
 */
export interface SiteFeatures {
  /**
   * #65: the account dashboard's submission and listing pages (`/account/submissions/<id>/`),
   * where a submitter edits and resubmits, and adds FAQs and links. On since #65 built them.
   */
  readonly accountDashboard: boolean
  /**
   * #66: the badge program (`lib/badge-program/`), which checks each free submitted or
   * badge-claimed listing every week, emails the owner when the badge goes missing, and
   * unpublishes the listing (or removes the claimer's ownership) when a recheck about 24 hours
   * later confirms it. Off: its Cron Trigger runs do nothing, and the submit pages and the
   * approval email don't promise weekly checks (`lib/feature-copy.ts`). The owner turns it on at
   * launch. Its emails link to #65's `/account/listings/<slug>/` (`email/emails/links.test.ts`),
   * and offer paid listings and claims only while `orders` and `claims` are on.
   */
  readonly badgeProgram: boolean
  /**
   * #67: claiming an existing listing with the badge or a payment (`lib/claims/`). Off: every
   * claim endpoint answers 404, and emails don't offer to claim a listing (again). It stays off
   * until the claim dialog (#70 screen 8) is built; see docs/CLAIMS.md.
   */
  readonly claims: boolean
  /**
   * #105: listing FAQs on the public listing page. On since #105 renders them; off, the
   * account's FAQ fields say FAQs will appear on the listing page soon.
   */
  readonly listingFaqs: boolean
  /**
   * #73: conversations with the SERP team (`/account/messages/`, `/admin/inbox/`). Off: emails
   * point to `/contact/` instead.
   */
  readonly messages: boolean
  /**
   * #68: orders (admin screen 13), with Stripe. Off: the admin sidebar hides Orders and
   * `/admin/orders/` stays a 404 (the admin catch-all), and the badge program's emails leave out
   * the paid upgrade and "Relist" offers.
   */
  readonly orders: boolean
}

export const features: SiteFeatures = {
  accountDashboard: true,
  badgeProgram: false,
  claims: false,
  listingFaqs: true,
  messages: false,
  orders: false
}
