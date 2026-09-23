CREATE TABLE `case_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`body` text NOT NULL,
	`internal` integer DEFAULT true NOT NULL,
	`author` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `service_cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `case_notes_case_date` ON `case_notes` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `competitors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'Direct' NOT NULL,
	`positioning` text DEFAULT '' NOT NULL,
	`strengths` text DEFAULT '' NOT NULL,
	`weaknesses` text DEFAULT '' NOT NULL,
	`differentiation` text DEFAULT '' NOT NULL,
	`objection_guidance` text DEFAULT '' NOT NULL,
	`battlecard` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitors_name` ON `competitors` (`name`);--> statement-breakpoint
CREATE TABLE `customer_portal_access` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`permissions_json` text DEFAULT '["cases","documents","onboarding","knowledge"]' NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_portal_token` ON `customer_portal_access` (`token_hash`);--> statement-breakpoint
CREATE INDEX `customer_portal_company` ON `customer_portal_access` (`company_id`);--> statement-breakpoint
CREATE TABLE `deal_competitors` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` integer NOT NULL,
	`competitor_id` text NOT NULL,
	`outcome` text DEFAULT 'Open' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`mentioned_at` text NOT NULL,
	`source` text DEFAULT 'Manual' NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`competitor_id`) REFERENCES `competitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deal_competitors_pair` ON `deal_competitors` (`deal_id`,`competitor_id`);--> statement-breakpoint
CREATE INDEX `deal_competitors_outcome` ON `deal_competitors` (`competitor_id`,`outcome`);--> statement-breakpoint
CREATE TABLE `field_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'Captured' NOT NULL,
	`contact_id` integer,
	`company_id` integer,
	`note` text DEFAULT '' NOT NULL,
	`audio_object_key` text,
	`attachment_object_key` text,
	`latitude` text,
	`longitude` text,
	`accuracy` integer,
	`captured_by` text NOT NULL,
	`captured_at` text NOT NULL,
	`synced_at` text,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_captures_user_date` ON `field_captures` (`captured_by`,`captured_at`);--> statement-breakpoint
CREATE TABLE `knowledge_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`status` text DEFAULT 'Draft' NOT NULL,
	`audience` text DEFAULT 'Customers' NOT NULL,
	`owner` text NOT NULL,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_articles_slug` ON `knowledge_articles` (`slug`);--> statement-breakpoint
CREATE INDEX `knowledge_articles_status` ON `knowledge_articles` (`status`,`category`);--> statement-breakpoint
CREATE TABLE `partner_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` integer,
	`name` text NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'Referral' NOT NULL,
	`tier` text DEFAULT 'Registered' NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`owner` text NOT NULL,
	`territory` text DEFAULT '' NOT NULL,
	`commission_percent` integer DEFAULT 10 NOT NULL,
	`permissions_json` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partner_companies_name` ON `partner_companies` (`name`);--> statement-breakpoint
CREATE INDEX `partner_companies_status` ON `partner_companies` (`status`);--> statement-breakpoint
CREATE TABLE `partner_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_company_id` text NOT NULL,
	`contact_id` integer,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'Partner rep' NOT NULL,
	`portal_access` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`partner_company_id`) REFERENCES `partner_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `partner_contacts_email` ON `partner_contacts` (`email`);--> statement-breakpoint
CREATE INDEX `partner_contacts_company` ON `partner_contacts` (`partner_company_id`);--> statement-breakpoint
CREATE TABLE `partner_payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_company_id` text NOT NULL,
	`referral_id` text,
	`deal_id` integer,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'Accrued' NOT NULL,
	`due_date` text,
	`paid_at` text,
	`reference` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`partner_company_id`) REFERENCES `partner_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`referral_id`) REFERENCES `partner_referrals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `partner_payouts_status_due` ON `partner_payouts` (`status`,`due_date`);--> statement-breakpoint
CREATE TABLE `partner_referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_company_id` text NOT NULL,
	`partner_contact_id` text,
	`deal_id` integer,
	`prospect_company` text NOT NULL,
	`prospect_contact` text DEFAULT '' NOT NULL,
	`prospect_email` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Submitted' NOT NULL,
	`protection_status` text DEFAULT 'Pending' NOT NULL,
	`protection_expires_at` text,
	`attribution_percent` integer DEFAULT 100 NOT NULL,
	`estimated_value` integer DEFAULT 0 NOT NULL,
	`owner` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`submitted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`partner_company_id`) REFERENCES `partner_companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`partner_contact_id`) REFERENCES `partner_contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `partner_referrals_status` ON `partner_referrals` (`status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `partner_referrals_deal` ON `partner_referrals` (`deal_id`);--> statement-breakpoint
CREATE TABLE `service_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`case_number` text NOT NULL,
	`parent_case_id` text,
	`source` text DEFAULT 'Manual' NOT NULL,
	`subject` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'Normal' NOT NULL,
	`queue` text DEFAULT 'General' NOT NULL,
	`status` text DEFAULT 'New' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`skills_json` text DEFAULT '[]' NOT NULL,
	`contact_id` integer,
	`company_id` integer,
	`deal_id` integer,
	`product` text DEFAULT '' NOT NULL,
	`inbox_message_id` text,
	`response_due_at` text,
	`resolution_due_at` text,
	`first_responded_at` text,
	`resolved_at` text,
	`escalated_at` text,
	`escalation_reason` text DEFAULT '' NOT NULL,
	`portal_visible` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inbox_message_id`) REFERENCES `inbox_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_cases_number` ON `service_cases` (`case_number`);--> statement-breakpoint
CREATE INDEX `service_cases_queue_status` ON `service_cases` (`queue`,`status`);--> statement-breakpoint
CREATE INDEX `service_cases_sla` ON `service_cases` (`response_due_at`,`resolution_due_at`);