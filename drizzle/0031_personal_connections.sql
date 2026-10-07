ALTER TABLE `integration_accounts` ADD `user_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `status` text DEFAULT 'connected' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `integration_accounts_provider_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `integration_accounts_provider_user_unique` ON `integration_accounts` (`provider`,`user_email`);--> statement-breakpoint
UPDATE `integration_accounts` SET `user_email`='trevor.cusworth@csi-automation.com' WHERE `provider` IN ('google','microsoft') AND `user_email`='';--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `account_id` integer;--> statement-breakpoint
ALTER TABLE `sync_records` ADD `account_id` integer;
