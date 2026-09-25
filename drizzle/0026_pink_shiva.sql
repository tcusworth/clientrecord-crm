CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limits_window` ON `rate_limits` (`window_start`);--> statement-breakpoint
ALTER TABLE `custom_object_fields` ADD `archived_at` text;