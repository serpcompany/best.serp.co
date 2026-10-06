CREATE TABLE `__new_badge_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` text NOT NULL,
	`checked_at` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`conclusive` integer NOT NULL,
	`kind` text DEFAULT 'weekly' NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "badge_checks_outcome_valid" CHECK("outcome" IN ('pass', 'fail')),
	CONSTRAINT "badge_checks_kind_valid" CHECK("kind" IN ('weekly', 'confirmation')),
	CONSTRAINT "badge_checks_conclusive_boolean" CHECK("conclusive" IN (0, 1)),
	CONSTRAINT "badge_checks_checked_at_iso" CHECK("checked_at" IS strftime('%Y-%m-%dT%H:%M:%fZ', "checked_at")),
	CONSTRAINT "badge_checks_pass_conclusive" CHECK("outcome" = 'fail' OR ("conclusive" = 1 AND "reason" IS NULL)),
	CONSTRAINT "badge_checks_fail_reason" CHECK("outcome" = 'pass' OR "reason" IS NOT NULL)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_badge_checks`("id", "listing_id", "checked_at", "outcome", "reason", "conclusive") SELECT "id", "listing_id", "checked_at", "outcome", "reason", "conclusive" FROM `badge_checks`;--> statement-breakpoint
DROP TABLE `badge_checks`;--> statement-breakpoint
ALTER TABLE `__new_badge_checks` RENAME TO `badge_checks`;--> statement-breakpoint
CREATE INDEX `badge_checks_listing_time_idx` ON `badge_checks` (`listing_id`,"checked_at" DESC,"id" DESC);
