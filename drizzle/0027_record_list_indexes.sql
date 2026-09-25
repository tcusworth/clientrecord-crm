CREATE INDEX `activities_contact_date` ON `activities` (`contact_id`,`happened_at`);--> statement-breakpoint
CREATE INDEX `activities_date` ON `activities` (`happened_at`);--> statement-breakpoint
CREATE INDEX `campaign_events_recipient_lower` ON `campaign_events` (lower("recipient"));--> statement-breakpoint
CREATE INDEX `companies_name_lower` ON `companies` (lower("name"));--> statement-breakpoint
CREATE INDEX `companies_temperature_name` ON `companies` (`temperature`,`name`);--> statement-breakpoint
CREATE INDEX `contacts_name_nocase` ON `contacts` ("last_name" COLLATE NOCASE,"first_name" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `contacts_stage` ON `contacts` (`stage`);--> statement-breakpoint
CREATE INDEX `contacts_company_key` ON `contacts` (lower(trim("company")));--> statement-breakpoint
CREATE INDEX `contacts_email_lower` ON `contacts` (lower("email"));--> statement-breakpoint
CREATE INDEX `contacts_last_contact` ON `contacts` (`last_contact`);--> statement-breakpoint
CREATE INDEX `contacts_next_follow_up` ON `contacts` (`next_follow_up`);--> statement-breakpoint
CREATE INDEX `tasks_contact` ON `tasks` (`contact_id`);--> statement-breakpoint
CREATE INDEX `tasks_open_due` ON `tasks` (`completed`,`due_date`);--> statement-breakpoint
-- One-time backfill: GET /api/sales and GET /api/crm no longer create companies from contact company names on every read;
-- contact write paths reconcile instead (lib/crm-records.ts). Idempotent: only names with no case-insensitive match are added.
INSERT INTO `companies`(`name`,`updated_at`) SELECT MIN(trim(c.`company`)),datetime('now') FROM `contacts` c WHERE trim(c.`company`)<>'' AND NOT EXISTS(SELECT 1 FROM `companies` existing WHERE lower(existing.`name`)=lower(trim(c.`company`))) GROUP BY lower(trim(c.`company`));
