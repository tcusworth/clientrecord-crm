CREATE TABLE `proposal_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` integer NOT NULL,
	`signer_name` text NOT NULL,
	`signer_email` text NOT NULL,
	`signer_title` text DEFAULT '' NOT NULL,
	`signature_text` text NOT NULL,
	`terms_snapshot` text NOT NULL,
	`ip_hash` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`accepted_at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `deal_proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_acceptances_proposal` ON `proposal_acceptances` (`proposal_id`);--> statement-breakpoint
CREATE INDEX `proposal_acceptances_email` ON `proposal_acceptances` (`signer_email`);--> statement-breakpoint
CREATE TABLE `proposal_share_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` integer NOT NULL,
	`type` text NOT NULL,
	`recipient` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `deal_proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `proposal_share_events_proposal_date` ON `proposal_share_events` (`proposal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `proposal_share_events_type` ON `proposal_share_events` (`type`);--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `share_token` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `share_expires_at` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `sent_to` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `contract_start_date` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `contract_end_date` text;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `renewal_term_months` integer;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `renewal_notice_days` integer;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `auto_renew` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `contract_terms` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `deal_proposals` ADD `contract_status` text DEFAULT 'Draft' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `deal_proposals_share_token` ON `deal_proposals` (`share_token`);--> statement-breakpoint
CREATE INDEX `deal_proposals_contract_dates` ON `deal_proposals` (`contract_end_date`);