CREATE TABLE `billing_events` (
	`provider` text NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`order_id` text,
	`outcome` text,
	`received_at` text NOT NULL,
	`processed_at` text,
	PRIMARY KEY(`provider`, `event_id`),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `billing_events_order_idx` ON `billing_events` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`purpose` text NOT NULL,
	`target_key` text NOT NULL,
	`submission_id` text,
	`listing_id` text,
	`claim_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`provider` text NOT NULL,
	`provider_checkout_id` text,
	`checkout_url` text,
	`checkout_expires_at` text,
	`provider_payment_id` text,
	`provider_refund_id` text,
	`charged_cents` integer,
	`charged_currency` text,
	`attention` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`failure_reason` text,
	`check_problem` text,
	`refund_reason` text,
	`refunded_by` text,
	`refund_listing_action` text,
	`refund_badge_check_id` integer,
	`refund_requested_at` text,
	`refund_attempts` integer DEFAULT 0 NOT NULL,
	`refund_retry_at` text,
	`refund_note` text,
	`paid_at` text,
	`applied_at` text,
	`refunded_at` text,
	`failed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_kind_valid" CHECK("orders"."kind" IN ('paid_listing', 'paid_claim')),
	CONSTRAINT "orders_purpose_valid" CHECK("orders"."purpose" IN ('submission', 'upgrade', 'relist', 'claim')),
	CONSTRAINT "orders_status_valid" CHECK("orders"."status" IN ('pending', 'paid', 'refunding', 'refunded', 'failed')),
	CONSTRAINT "orders_outcome_valid" CHECK("orders"."outcome" IS NULL OR "orders"."outcome" IN ('published', 'held', 'upgraded', 'relisted', 'claimed', 'unapplied')),
	CONSTRAINT "orders_refund_listing_action_valid" CHECK("orders"."refund_listing_action" IS NULL
        OR "orders"."refund_listing_action" IN ('keep_free', 'unpublish', 'already_unpublished', 'none')),
	CONSTRAINT "orders_attention_valid" CHECK("orders"."attention" IS NULL OR "orders"."attention" IN ('amount_mismatch', 'refund_failed')),
	CONSTRAINT "orders_refund_reason_valid" CHECK("orders"."refund_reason" IS NULL OR "orders"."refund_reason" IN ('rejected', 'admin', 'unapplied')),
	CONSTRAINT "orders_target_matches_purpose" CHECK(("orders"."purpose" = 'claim' AND "orders"."kind" = 'paid_claim'
        AND "orders"."claim_id" IS NOT NULL AND "orders"."listing_id" IS NOT NULL
        AND "orders"."target_key" = 'claim:' || "orders"."claim_id")
      OR ("orders"."purpose" = 'submission' AND "orders"."kind" = 'paid_listing'
        AND "orders"."submission_id" IS NOT NULL AND "orders"."claim_id" IS NULL
        AND "orders"."target_key" = 'submission:' || "orders"."submission_id")
      OR ("orders"."purpose" IN ('upgrade', 'relist') AND "orders"."kind" = 'paid_listing'
        AND "orders"."submission_id" IS NOT NULL AND "orders"."listing_id" IS NOT NULL
        AND "orders"."claim_id" IS NULL AND "orders"."target_key" = 'listing:' || "orders"."listing_id")),
	CONSTRAINT "orders_amount_positive" CHECK("orders"."amount_cents" > 0),
	CONSTRAINT "orders_refund_attempts_valid" CHECK("orders"."refund_attempts" >= 0),
	CONSTRAINT "orders_currency_valid" CHECK("orders"."currency" GLOB '[a-z][a-z][a-z]'),
	CONSTRAINT "orders_paid_recorded" CHECK("orders"."status" IN ('pending', 'failed')
        OR ("orders"."paid_at" IS NOT NULL AND "orders"."provider_payment_id" IS NOT NULL
          AND "orders"."charged_cents" IS NOT NULL AND "orders"."charged_currency" IS NOT NULL)),
	CONSTRAINT "orders_refund_recorded" CHECK(("orders"."status" = 'refunded') = ("orders"."refunded_at" IS NOT NULL)
        AND ("orders"."status" IN ('refunding', 'refunded')) = ("orders"."refund_reason" IS NOT NULL)
        AND ("orders"."refund_reason" IS NULL) = ("orders"."refund_requested_at" IS NULL)
        AND ("orders"."refund_reason" = 'admin') = ("orders"."refund_listing_action" IS NOT NULL)),
	CONSTRAINT "orders_outcome_after_payment" CHECK(("orders"."outcome" IS NULL) = ("orders"."applied_at" IS NULL)
        AND ("orders"."applied_at" IS NULL OR "orders"."paid_at" IS NOT NULL)),
	CONSTRAINT "orders_failed_recorded" CHECK(("orders"."status" = 'failed') = ("orders"."failed_at" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_number_idx` ON `orders` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_open_target_idx` ON `orders` (`target_key`) WHERE "orders"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `orders_provider_checkout_idx` ON `orders` (`provider`,`provider_checkout_id`) WHERE "orders"."provider_checkout_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `orders_status_created_idx` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_submission_idx` ON `orders` (`submission_id`);--> statement-breakpoint
CREATE INDEX `orders_listing_idx` ON `orders` (`listing_id`);--> statement-breakpoint
CREATE INDEX `orders_user_idx` ON `orders` (`user_id`,`created_at`);