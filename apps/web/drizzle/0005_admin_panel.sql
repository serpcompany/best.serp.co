CREATE TABLE `listing_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`event_type` text NOT NULL,
	`detail` text,
	`actor` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "listing_events_type_valid" CHECK("event_type" IN ('edited', 'unpublished', 'republished', 'link_rel_changed', 'owner_granted', 'owner_revoked', 'owner_transferred'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `listing_events_listing_idx` ON `listing_events` (`listing_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_listing_owners` (
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
	CONSTRAINT "listing_owners_role_valid" CHECK("role" IN ('owner')),
	CONSTRAINT "listing_owners_verified_via_valid" CHECK("verified_via" IN ('submission', 'badge_claim', 'paid_claim', 'admin')),
	CONSTRAINT "listing_owners_revocation_complete" CHECK(("revoked_at" IS NULL) = ("revoked_reason" IS NULL))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_listing_owners`("id", "listing_id", "user_id", "role", "verified_via", "verified_at", "revoked_at", "revoked_reason", "created_at") SELECT "id", "listing_id", "user_id", "role", "verified_via", "verified_at", "revoked_at", "revoked_reason", "created_at" FROM `listing_owners`;--> statement-breakpoint
DROP TABLE `listing_owners`;--> statement-breakpoint
ALTER TABLE `__new_listing_owners` RENAME TO `listing_owners`;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_owners_current_owner_idx` ON `listing_owners` (`listing_id`) WHERE "listing_owners"."role" = 'owner' AND "listing_owners"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `listing_owners_current_member_idx` ON `listing_owners` (`listing_id`,`user_id`) WHERE "listing_owners"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `listing_owners_listing_idx` ON `listing_owners` (`listing_id`);--> statement-breakpoint
CREATE INDEX `listing_owners_user_idx` ON `listing_owners` (`user_id`,`listing_id`);
