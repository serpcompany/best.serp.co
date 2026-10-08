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
   * later confirms it. On since #130 (the owner's launch decision): its Cron Triggers run, and
   * the submit pages, the account's badge panel, the claim dialog and the approval email promise
   * weekly checks (`lib/feature-copy.ts`). Off, its runs would do nothing and that copy would be
   * left out. Its emails link to #65's `/account/listings/<slug>/` (`email/emails/links.test.ts`),
   * and offer a paid listing only while `orders` is on, and claiming again (by the badge or a
   * payment) only while `claims` and `orders` both are.
   */
  readonly badgeProgram: boolean
  /**
   * #67: claiming an existing listing with the badge or a payment (`lib/claims/`), from the
   * listing page's "Claim this listing" link and dialog (#70 screens 8 and 9). On since #130;
   * the payment method too since `orders` is on (#133). Off, every claim endpoint would answer
   * 404, the listing page would show no claim link, and emails wouldn't offer to claim a
   * listing (again). See docs/CLAIMS.md.
   */
  readonly claims: boolean
  /**
   * #105: listing FAQs on the public listing page. On since #105 renders them; off, the
   * account's FAQ fields say FAQs will appear on the listing page soon.
   */
  readonly listingFaqs: boolean
  /**
   * #73: conversations with the SERP team (`/account/messages/`, `/admin/inbox/`). Off: emails
   * and the claim dialog's contact path point to `/contact/` instead.
   */
  readonly messages: boolean
  /**
   * #68: paid listings ($49 one-off) and orders (admin screen 13), through the billing provider
   * (`lib/billing/`). On since #133 (the owner's decision, with the provider's secrets set on
   * staging and production): the submit flow offers the paid plan, the account offers "Upgrade"
   * and "Relist", the claim dialog offers a payment, the admin sidebar shows Orders, the draft
   * reminder and the badge program's emails make their paid offers, and the hourly billing sweep
   * runs (it fails the trigger without the secrets). Off, all of that is hidden, every checkout
   * route and the webhook answer 404, and `/admin/orders/` is a 404 (the admin catch-all).
   */
  readonly orders: boolean
}

export const features: SiteFeatures = {
  accountDashboard: true,
  badgeProgram: true,
  claims: true,
  listingFaqs: true,
  messages: false,
  orders: true
}
