DROP TABLE `listing_submission_notifications`;--> statement-breakpoint
DROP INDEX `listing_submissions_token_unique`;--> statement-breakpoint
ALTER TABLE `listing_submissions` DROP COLUMN `access_token_hash`;