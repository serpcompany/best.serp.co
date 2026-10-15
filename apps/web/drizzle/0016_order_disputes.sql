-- serpcompany/best.serp.co#473: a buyer's dispute of a payment, recorded on its order.
-- Hand-finished (docs/data-model.md): `orders` only gains columns. Drizzle rebuilds the table to
-- add a CHECK, and `billing_events` references `orders`.
ALTER TABLE `orders` ADD `dispute_status` text CONSTRAINT "orders_dispute_status_valid" CHECK("dispute_status" IS NULL OR "dispute_status" IN ('open', 'won', 'lost'));--> statement-breakpoint
ALTER TABLE `orders` ADD `disputed_at` text CONSTRAINT "orders_dispute_recorded" CHECK(("dispute_status" IS NULL) = ("disputed_at" IS NULL));
