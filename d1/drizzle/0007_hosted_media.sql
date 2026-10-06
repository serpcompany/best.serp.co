CREATE TABLE `media_ingestions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text,
	`submission_id` text,
	`kind` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`source_url` text NOT NULL,
	`copy_from_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`media_key` text,
	`sha256` text,
	`content_type` text,
	`bytes` integer,
	`width` integer,
	`height` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_ingestions_one_target" CHECK(("media_ingestions"."listing_id" IS NULL) != ("media_ingestions"."submission_id" IS NULL)),
	CONSTRAINT "media_ingestions_kind_valid" CHECK("media_ingestions"."kind" IN ('logo', 'image')),
	CONSTRAINT "media_ingestions_status_valid" CHECK("media_ingestions"."status" IN ('pending', 'hosted', 'failed')),
	CONSTRAINT "media_ingestions_attempts_nonnegative" CHECK("media_ingestions"."attempts" >= 0),
	CONSTRAINT "media_ingestions_pending_scheduled" CHECK(("media_ingestions"."status" = 'pending') = ("media_ingestions"."next_attempt_at" IS NOT NULL)),
	CONSTRAINT "media_ingestions_next_attempt_iso" CHECK("media_ingestions"."next_attempt_at" IS NULL OR "next_attempt_at" IS strftime('%Y-%m-%dT%H:%M:%fZ', "next_attempt_at")),
	CONSTRAINT "media_ingestions_failed_explained" CHECK("media_ingestions"."status" != 'failed' OR "media_ingestions"."last_error" IS NOT NULL),
	CONSTRAINT "media_ingestions_hosted_result" CHECK(("media_ingestions"."status" = 'hosted') = ("media_ingestions"."media_key" IS NOT NULL)),
	CONSTRAINT "media_ingestions_hosted_complete" CHECK(("media_key" IS NULL AND "sha256" IS NULL
    AND "content_type" IS NULL AND "bytes" IS NULL
    AND "width" IS NULL AND "height" IS NULL)
    OR ("media_key" IS NOT NULL AND "sha256" IS NOT NULL
    AND "content_type" IS NOT NULL AND "bytes" IS NOT NULL
    AND "width" IS NOT NULL AND "height" IS NOT NULL
    AND (substr("media_key", 1, 22) = 'best.serp.co/listings/' OR substr("media_key", 1, 25) = 'best.serp.co/submissions/')
    AND instr("media_key", '/' || "kind" || '/') > 0
    AND length("sha256") = 64
    AND "content_type" IN ('image/avif', 'image/gif', 'image/x-icon', 'image/jpeg', 'image/png', 'image/webp')
    AND "bytes" BETWEEN 1 AND 5242880
    AND "width" BETWEEN 1 AND 16384
    AND "height" BETWEEN 1 AND 16384)),
	CONSTRAINT "media_ingestions_copy_from_submission" CHECK("media_ingestions"."copy_from_key" IS NULL OR ("media_ingestions"."listing_id" IS NOT NULL AND (substr("copy_from_key", 1, 25) = 'best.serp.co/submissions/')))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `media_ingestions_listing_slot_idx` ON `media_ingestions` (`listing_id`,`kind`,`sort_order`) WHERE "media_ingestions"."listing_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `media_ingestions_submission_slot_idx` ON `media_ingestions` (`submission_id`,`kind`,`sort_order`) WHERE "media_ingestions"."submission_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `media_ingestions_due_idx` ON `media_ingestions` (`next_attempt_at`) WHERE "media_ingestions"."status" = 'pending';--> statement-breakpoint
-- Hand-finished (docs/DATA_MODEL.md): listing_media only gains nullable columns. A rebuild would
-- need foreign keys switched off, which D1 ignores inside a migration's transaction.
ALTER TABLE `listing_media` ADD `media_key` text;--> statement-breakpoint
ALTER TABLE `listing_media` ADD `sha256` text;--> statement-breakpoint
ALTER TABLE `listing_media` ADD `content_type` text;--> statement-breakpoint
ALTER TABLE `listing_media` ADD `bytes` integer;--> statement-breakpoint
ALTER TABLE `listing_media` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `listing_media` ADD `height` integer CONSTRAINT "listing_media_hosted_complete" CHECK(("media_key" IS NULL AND "sha256" IS NULL
    AND "content_type" IS NULL AND "bytes" IS NULL
    AND "width" IS NULL AND "height" IS NULL)
    OR ("media_key" IS NOT NULL AND "sha256" IS NOT NULL
    AND "content_type" IS NOT NULL AND "bytes" IS NOT NULL
    AND "width" IS NOT NULL AND "height" IS NOT NULL
    AND (substr("media_key", 1, 22) = 'best.serp.co/listings/')
    AND instr("media_key", '/' || "kind" || '/') > 0
    AND length("sha256") = 64
    AND "content_type" IN ('image/avif', 'image/gif', 'image/x-icon', 'image/jpeg', 'image/png', 'image/webp')
    AND "bytes" BETWEEN 1 AND 5242880
    AND "width" BETWEEN 1 AND 16384
    AND "height" BETWEEN 1 AND 16384));
