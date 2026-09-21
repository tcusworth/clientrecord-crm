CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`stage` text DEFAULT 'Prospect' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`primary_contact_id` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`primary_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_name_unique` ON `companies` (`name`);--> statement-breakpoint
CREATE TABLE `consent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `location` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `notes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `segments` ADD `location` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `owner` text DEFAULT 'Trevor' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `status` text DEFAULT 'Open' NOT NULL;