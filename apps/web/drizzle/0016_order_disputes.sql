-- serpcompany/best.serp.co#473: a buyer's dispute of a payment, recorded on its order.
-- Hand-finished (docs/data-model.md): `orders` only gains columns. Drizzle rebuilds the table to
-- add a CHECK, and `billing_events` references `orders`.
ALTER TABLE `orders` ADD `dispute_status` text CONSTRAINT "orders_dispute_status_valid" CHECK("dispute_status" IS NULL OR "dispute_status" IN ('open', 'won', 'lost'));--> statement-breakpoint
ALTER TABLE `orders` ADD `disputed_at` text CONSTRAINT "orders_dispute_recorded" CHECK(("dispute_status" IS NULL) = ("disputed_at" IS NULL));--> statement-breakpoint
-- A refund's or a dispute's payment finds its order; the sweep reads recent payment alerts.
CREATE INDEX `billing_events_processed_idx` ON `billing_events` (`processed_at`);--> statement-breakpoint
CREATE INDEX `orders_provider_payment_idx` ON `orders` (`provider`,`provider_payment_id`) WHERE "orders"."provider_payment_id" IS NOT NULL;
