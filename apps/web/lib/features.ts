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
   * launch, once #65's `/account/listings/<slug>/` pages are live (`email/emails/links.test.ts`).
   */
  readonly badgeProgram: boolean
  /**
   * #105: listing FAQs on the public listing page. Off: the account's FAQ fields say FAQs will
   * appear on the listing page soon, instead of "Shown on your listing page."
   */
  readonly listingFaqs: boolean
  /**
   * #73: conversations with the SERP team (`/account/messages/`, `/admin/inbox/`). Off: emails
   * point to `/contact/` instead.
   */
  readonly messages: boolean
  /**
   * #68: orders (admin screen 13), with Stripe. Off: the admin sidebar hides Orders and
   * `/admin/orders/` stays a 404 (the admin catch-all).
   */
  readonly orders: boolean
}

export const features: SiteFeatures = {
  accountDashboard: true,
  badgeProgram: false,
  listingFaqs: false,
  messages: false,
  orders: false
}
