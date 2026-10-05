ALTER TABLE `listings` ADD `source` text DEFAULT 'admin' NOT NULL CONSTRAINT "listings_source_valid" CHECK("source" IN ('admin', 'submission'));--> statement-breakpoint
ALTER TABLE `listings` ADD `link_rel` text DEFAULT 'follow' NOT NULL CONSTRAINT "listings_link_rel_valid" CHECK("link_rel" IN ('follow', 'nofollow', 'sponsored'));--> statement-breakpoint
UPDATE `listings` SET `source` = 'submission' WHERE `source_kind` = 'verified-submission';--> statement-breakpoint
CREATE TABLE `__new_listing_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`website` text NOT NULL,
	`content` text NOT NULL,
	`category_slug` text NOT NULL,
	`logo_url` text NOT NULL,
	`video_url` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`access_token_hash` text,
	`verification_attempts` integer DEFAULT 0 NOT NULL,
	`last_verification_at` text,
	`last_verification_error` text,
	`badge_verified_at` text,
	`reviewed_at` text,
	`reviewed_by` text,
	`listing_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`owner_user_id` text,
	`plan` text,
	`paid_at` text,
	`refunded_at` text,
	`reviewer_note` text,
	`rejection_reason` text,
	`rejection_category` text,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "listing_submissions_status_valid" CHECK("status" IN ('draft', 'pending_badge', 'verified', 'paid_pending_review', 'changes_requested', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "listing_submissions_verification_attempts_nonnegative" CHECK("verification_attempts" >= 0),
	CONSTRAINT "listing_submissions_plan_valid" CHECK("plan" IS NULL OR "plan" IN ('free', 'paid')),
	CONSTRAINT "listing_submissions_plan_chosen" CHECK("status" IN ('draft', 'withdrawn') OR "plan" IS NOT NULL),
	CONSTRAINT "listing_submissions_draft_unpaid" CHECK("status" != 'draft' OR ("paid_at" IS NULL AND "listing_id" IS NULL)),
	CONSTRAINT "listing_submissions_pending_badge_free" CHECK("status" != 'pending_badge' OR "plan" = 'free'),
	CONSTRAINT "listing_submissions_payment_matches_plan" CHECK("paid_at" IS NULL OR "plan" = 'paid' OR "refunded_at" IS NOT NULL),
	CONSTRAINT "listing_submissions_refund_after_payment" CHECK("refunded_at" IS NULL OR "paid_at" IS NOT NULL),
	CONSTRAINT "listing_submissions_verified_qualified" CHECK("status" != 'verified' OR "plan" = 'free' OR "paid_at" IS NOT NULL),
	CONSTRAINT "listing_submissions_rejection_category_valid" CHECK("rejection_category" IS NULL OR "rejection_category" IN ('prohibited', 'other')),
	CONSTRAINT "listing_submissions_rejection_complete" CHECK(("rejection_reason" IS NULL) = ("rejection_category" IS NULL)),
	CONSTRAINT "listing_submissions_rejection_when_rejected" CHECK("rejection_category" IS NULL OR "status" = 'rejected'),
	CONSTRAINT "listing_submissions_live_review_paid" CHECK("status" != 'paid_pending_review' OR ("listing_id" IS NOT NULL AND "plan" = 'paid' AND "paid_at" IS NOT NULL AND "refunded_at" IS NULL))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_listing_submissions`("id", "slug", "name", "description", "website", "content", "category_slug", "logo_url", "video_url", "status", "access_token_hash", "verification_attempts", "last_verification_at", "last_verification_error", "badge_verified_at", "reviewed_at", "reviewed_by", "listing_id", "created_at", "updated_at", "plan") SELECT "id", "slug", "name", "description", "website", "content", "category_slug", "logo_url", "video_url", "status", "access_token_hash", "verification_attempts", "last_verification_at", "last_verification_error", "badge_verified_at", "reviewed_at", "reviewed_by", "listing_id", "created_at", "updated_at", 'free' FROM `listing_submissions`;--> statement-breakpoint
CREATE TABLE `__new_listing_submission_resource_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `__new_listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_listing_submission_resource_links`("id", "submission_id", "label", "url", "sort_order") SELECT "id", "submission_id", "label", "url", "sort_order" FROM `listing_submission_resource_links`;--> statement-breakpoint
CREATE TABLE `__new_listing_submission_faqs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `__new_listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_listing_submission_faqs`("id", "submission_id", "question", "answer", "sort_order") SELECT "id", "submission_id", "question", "answer", "sort_order" FROM `listing_submission_faqs`;--> statement-breakpoint
CREATE TABLE `__new_listing_submission_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` text NOT NULL,
	`event_type` text NOT NULL,
	`detail` text,
	`actor` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `__new_listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_submission_events_type_valid" CHECK("event_type" IN ('created', 'verification_failed', 'badge_verified', 'approved', 'rejected', 'edited', 'resubmitted', 'changes_requested', 'withdrawn', 'paid', 'refunded', 'unpublished', 'plan_chosen'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_listing_submission_events`("id", "submission_id", "event_type", "detail", "actor", "created_at") SELECT "id", "submission_id", "event_type", "detail", "actor", "created_at" FROM `listing_submission_events`;--> statement-breakpoint
CREATE TABLE `__new_listing_submission_notifications` (
	`submission_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`external_url` text NOT NULL,
	`recipient` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`preview_token_hash` text,
	PRIMARY KEY(`submission_id`, `channel`),
	FOREIGN KEY (`submission_id`) REFERENCES `__new_listing_submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_submission_notifications_channel_valid" CHECK("channel" IN ('github_issue'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_listing_submission_notifications`("submission_id", "channel", "external_id", "external_url", "recipient", "created_at", "updated_at", "preview_token_hash") SELECT "submission_id", "channel", "external_id", "external_url", "recipient", "created_at", "updated_at", "preview_token_hash" FROM `listing_submission_notifications`;--> statement-breakpoint
DROP TABLE `listing_submission_resource_links`;--> statement-breakpoint
DROP TABLE `listing_submission_faqs`;--> statement-breakpoint
DROP TABLE `listing_submission_events`;--> statement-breakpoint
DROP TABLE `listing_submission_notifications`;--> statement-breakpoint
DROP TABLE `listing_submissions`;--> statement-breakpoint
ALTER TABLE `__new_listing_submissions` RENAME TO `listing_submissions`;--> statement-breakpoint
ALTER TABLE `__new_listing_submission_resource_links` RENAME TO `listing_submission_resource_links`;--> statement-breakpoint
ALTER TABLE `__new_listing_submission_faqs` RENAME TO `listing_submission_faqs`;--> statement-breakpoint
ALTER TABLE `__new_listing_submission_events` RENAME TO `listing_submission_events`;--> statement-breakpoint
ALTER TABLE `__new_listing_submission_notifications` RENAME TO `listing_submission_notifications`;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submissions_active_slug_idx` ON `listing_submissions` (`slug`) WHERE "listing_submissions"."status" IN ('draft', 'pending_badge', 'verified', 'paid_pending_review', 'changes_requested');--> statement-breakpoint
CREATE INDEX `listing_submissions_review_queue_idx` ON `listing_submissions` (`status`,`badge_verified_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `listing_submissions_owner_idx` ON `listing_submissions` (`owner_user_id`,`created_at`) WHERE "listing_submissions"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `listing_submissions_listing_idx` ON `listing_submissions` (`listing_id`) WHERE "listing_submissions"."listing_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submissions_token_unique` ON `listing_submissions` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_resource_links_submission_order_unique` ON `listing_submission_resource_links` (`submission_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_faqs_submission_order_unique` ON `listing_submission_faqs` (`submission_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `listing_submission_events_submission_idx` ON `listing_submission_events` (`submission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `listing_submission_notifications_recipient_idx` ON `listing_submission_notifications` (`channel`,`recipient`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_notifications_preview_token_idx` ON `listing_submission_notifications` (`preview_token_hash`) WHERE "listing_submission_notifications"."preview_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_notifications_channel_external_unique` ON `listing_submission_notifications` (`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE `listing_submission_url_blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url_key` text NOT NULL,
	`submission_id` text,
	`reason` text NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` text NOT NULL,
	`lifted_at` text,
	`lifted_by` text,
	`lift_note` text,
	FOREIGN KEY (`submission_id`) REFERENCES `listing_submissions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "listing_submission_url_blocks_lift_complete" CHECK(("listing_submission_url_blocks"."lifted_at" IS NULL) = ("listing_submission_url_blocks"."lifted_by" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_submission_url_blocks_active_idx` ON `listing_submission_url_blocks` (`url_key`) WHERE "listing_submission_url_blocks"."lifted_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER listing_submissions_refuse_blocked_url BEFORE INSERT ON listing_submissions
WHEN EXISTS (SELECT 1 FROM listing_submission_url_blocks WHERE url_key = new.slug AND lifted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'submission url is blocked until an admin lifts the block');
END;
--> statement-breakpoint
CREATE TABLE `listing_owners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`verified_via` text NOT NULL,
	`verified_at` text NOT NULL,
	`revoked_at` text,
	`revoked_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "listing_owners_role_valid" CHECK("listing_owners"."role" IN ('owner')),
	CONSTRAINT "listing_owners_verified_via_valid" CHECK("listing_owners"."verified_via" IN ('submission', 'badge_claim', 'paid_claim')),
	CONSTRAINT "listing_owners_revocation_complete" CHECK(("listing_owners"."revoked_at" IS NULL) = ("listing_owners"."revoked_reason" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_owners_current_owner_idx` ON `listing_owners` (`listing_id`) WHERE "listing_owners"."role" = 'owner' AND "listing_owners"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_owners_current_member_idx` ON `listing_owners` (`listing_id`,`user_id`) WHERE "listing_owners"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `listing_owners_user_idx` ON `listing_owners` (`user_id`,`listing_id`) WHERE "listing_owners"."revoked_at" IS NULL;--> statement-breakpoint
CREATE TABLE `listing_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`base_checksum` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content` text,
	`category_slug` text NOT NULL,
	`logo_url` text,
	`video_url` text,
	`reviewer_note` text,
	`rejection_reason` text,
	`reviewed_at` text,
	`reviewed_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "listing_revisions_status_valid" CHECK("listing_revisions"."status" IN ('pending_review', 'changes_requested', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "listing_revisions_rejection_when_rejected" CHECK("listing_revisions"."rejection_reason" IS NULL OR "listing_revisions"."status" = 'rejected')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_revisions_open_idx` ON `listing_revisions` (`listing_id`) WHERE "listing_revisions"."status" IN ('pending_review', 'changes_requested');--> statement-breakpoint
CREATE INDEX `listing_revisions_review_queue_idx` ON `listing_revisions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `listing_revisions_author_idx` ON `listing_revisions` (`author_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `listing_revision_resource_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `listing_revisions`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_revision_resource_links_revision_order_unique` ON `listing_revision_resource_links` (`revision_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_revision_faqs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `listing_revisions`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_revision_faqs_revision_order_unique` ON `listing_revision_faqs` (`revision_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `listing_revision_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` text NOT NULL,
	`event_type` text NOT NULL,
	`detail` text,
	`actor` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `listing_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_revision_events_type_valid" CHECK("listing_revision_events"."event_type" IN ('created', 'edited', 'changes_requested', 'resubmitted', 'withdrawn', 'approved', 'rejected'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_revision_events_revision_idx` ON `listing_revision_events` (`revision_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `badge_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`checked_at` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`conclusive` integer NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "badge_checks_outcome_valid" CHECK("badge_checks"."outcome" IN ('pass', 'fail')),
	CONSTRAINT "badge_checks_conclusive_boolean" CHECK("conclusive" IN (0, 1)),
	CONSTRAINT "badge_checks_pass_conclusive" CHECK("badge_checks"."outcome" = 'fail' OR ("badge_checks"."conclusive" = 1 AND "badge_checks"."reason" IS NULL)),
	CONSTRAINT "badge_checks_fail_reason" CHECK("badge_checks"."outcome" = 'pass' OR "badge_checks"."reason" IS NOT NULL)
) STRICT;
--> statement-breakpoint
CREATE INDEX `badge_checks_listing_time_idx` ON `badge_checks` (`listing_id`,"checked_at" DESC,"id" DESC);
