CREATE TABLE `segments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`stage` text DEFAULT 'Any' NOT NULL,
	`tag` text DEFAULT '' NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`subscription` text DEFAULT 'Subscribed' NOT NULL,
	`inactivity_days` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `segments_name_unique` ON `segments` (`name`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`source` text DEFAULT 'Manual' NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_email_unique` ON `suppressions` (`email`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `phone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `suppression_reason` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `suppressed_at` text;--> statement-breakpoint
ALTER TABLE `contacts` ADD `updated_at` text DEFAULT '' NOT NULL;