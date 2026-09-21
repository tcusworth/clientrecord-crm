CREATE TABLE `brand_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`business_name` text DEFAULT '' NOT NULL,
	`logo_url` text DEFAULT '' NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`from_email` text DEFAULT '' NOT NULL,
	`reply_to_email` text DEFAULT '' NOT NULL,
	`sending_domain` text DEFAULT '' NOT NULL,
	`physical_address` text DEFAULT '' NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
