ALTER TABLE `companies` ADD `summary` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `headquarters` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `linkedin_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `logo_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `employee_range` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `enrichment_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `enrichment_confidence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `companies` ADD `enriched_at` text;