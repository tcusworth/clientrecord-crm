ALTER TABLE `contacts` ADD `first_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `latest_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `form_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text,
	`contact_id` integer,
	`action` text NOT NULL,
	`source` text NOT NULL,
	`report_name` text DEFAULT '' NOT NULL,
	`consent` integer,
	`consent_text` text DEFAULT '' NOT NULL,
	`referrer` text DEFAULT '' NOT NULL,
	`utm_source` text DEFAULT '' NOT NULL,
	`utm_medium` text DEFAULT '' NOT NULL,
	`utm_campaign` text DEFAULT '' NOT NULL,
	`utm_term` text DEFAULT '' NOT NULL,
	`utm_content` text DEFAULT '' NOT NULL,
	`note_title` text DEFAULT '' NOT NULL,
	`lists_json` text DEFAULT '[]' NOT NULL,
	`task_id` integer,
	`api_key_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `form_submissions_submission_id_unique` ON `form_submissions` (`submission_id`) WHERE `submission_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `form_submissions_source_idx` ON `form_submissions` (`source`);--> statement-breakpoint
CREATE INDEX `form_submissions_contact_idx` ON `form_submissions` (`contact_id`);--> statement-breakpoint
CREATE INDEX `form_submissions_campaign_idx` ON `form_submissions` (`utm_campaign`);--> statement-breakpoint
CREATE TABLE `contact_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_lists_name_unique` ON `contact_lists` (lower(`name`));--> statement-breakpoint
CREATE TABLE `contact_list_members` (
	`list_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`added_at` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`list_id`, `contact_id`),
	FOREIGN KEY (`list_id`) REFERENCES `contact_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);