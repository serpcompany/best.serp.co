/**
 * Admin panel features that wait on other steps of #59.
 *
 * Orders (screen 13) need #68's `orders` ledger and Stripe: until #68 ships, the sidebar hides
 * the entry and `/admin/orders/` stays a 404 (the admin catch-all). #68 builds the page and turns
 * this on.
 */
export const ADMIN_ORDERS_ENABLED = false
