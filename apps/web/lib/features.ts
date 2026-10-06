/**
 * Site areas that later steps of #59 ship. Whatever depends on one of them (email copy and
 * links, admin navigation) reads its flag here instead of promising it early. The issue that
 * builds the area turns the flag on, and the approved wording and links come back on their own:
 * `apps/web/lib/email/emails/links.test.ts` then requires the pages they link to.
 */
export interface SiteFeatures {
  /**
   * #65: the account dashboard's submission and listing pages (`/account/submissions/<id>/`),
   * where a submitter edits and resubmits. Off: emails send people to `/submit/` instead.
   */
  readonly accountDashboard: boolean
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
  accountDashboard: false,
  messages: false,
  orders: false
}
