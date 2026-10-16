-- serpcompany/best.serp.co#484: how much of a payment a partial refund outside the site sent back.
-- Hand-finished (docs/data-model.md): `orders` only gains a column. Drizzle rebuilds the table to
-- add a CHECK, and `billing_events` references `orders`.
ALTER TABLE `orders` ADD `partial_refund_cents` integer CONSTRAINT "orders_partial_refund_valid" CHECK("partial_refund_cents" IS NULL OR "partial_refund_cents" > 0);
