CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `backup_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`status` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`checksum` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`restored_at` text
);
--> statement-breakpoint
CREATE TABLE `delivery_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`recipient` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`external_id` text,
	`error` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_logs_status_date` ON `delivery_logs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'Completed' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`rolled_back_at` text
);
--> statement-breakpoint
CREATE TABLE `import_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`change_type` text NOT NULL,
	`before_json` text,
	`after_json` text,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_changes_batch` ON `import_changes` (`batch_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_type` text NOT NULL,
	`status` text NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `job_runs_type_started` ON `job_runs` (`job_type`,`started_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`action_url` text,
	`read_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_owner_read` ON `notifications` (`owner_email`,`read_at`);--> statement-breakpoint
CREATE TABLE `operation_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`daily_backup_hour` integer DEFAULT 2 NOT NULL,
	`stagnation_days` integer DEFAULT 14 NOT NULL,
	`post_meeting_task_days` integer DEFAULT 1 NOT NULL,
	`audit_retention_days` integer DEFAULT 730 NOT NULL,
	`event_retention_days` integer DEFAULT 90 NOT NULL,
	`delivery_retention_days` integer DEFAULT 180 NOT NULL,
	`sync_retention_days` integer DEFAULT 365 NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `system_events_status` ON `system_events` (`severity`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`endpoint_id` text NOT NULL,
	`event` text NOT NULL,
	`status` text NOT NULL,
	`response_status` integer,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_date` ON `webhook_deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`events` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_status` integer,
	`last_triggered_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `automation_enrollments` ADD `stopped_reason` text;--> statement-breakpoint
ALTER TABLE `automation_enrollments` ADD `replied_at` text;--> statement-breakpoint
ALTER TABLE `deals` ADD `campaign` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD `partner` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `deals` ADD `forecast_category` text DEFAULT 'Pipeline' NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `sync_email` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `sync_calendar` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `auto_tasks` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `team_members` ADD `permissions` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `audit_contacts_update` AFTER UPDATE ON `contacts` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','contact',CAST(NEW.id AS TEXT),'Contact changed',json_object('before',json_object('first_name',OLD.first_name,'last_name',OLD.last_name,'email',OLD.email,'company',OLD.company,'title',OLD.title,'phone',OLD.phone,'location',OLD.location,'notes',OLD.notes,'lead_source',OLD.lead_source,'stage',OLD.stage,'tags',OLD.tags,'subscribed',OLD.subscribed,'next_follow_up',OLD.next_follow_up),'after',json_object('first_name',NEW.first_name,'last_name',NEW.last_name,'email',NEW.email,'company',NEW.company,'title',NEW.title,'phone',NEW.phone,'location',NEW.location,'notes',NEW.notes,'lead_source',NEW.lead_source,'stage',NEW.stage,'tags',NEW.tags,'subscribed',NEW.subscribed,'next_follow_up',NEW.next_follow_up)),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_contacts_delete` BEFORE DELETE ON `contacts` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.delete','contact',CAST(OLD.id AS TEXT),'Contact deleted',json_object('before',json_object('first_name',OLD.first_name,'last_name',OLD.last_name,'email',OLD.email,'company',OLD.company,'stage',OLD.stage,'tags',OLD.tags),'after',NULL),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_companies_update` AFTER UPDATE ON `companies` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','company',CAST(NEW.id AS TEXT),'Company changed',json_object('before',json_object('name',OLD.name,'stage',OLD.stage,'website',OLD.website,'industry',OLD.industry,'tier',OLD.tier,'territory',OLD.territory,'owner',OLD.owner,'fit_score',OLD.fit_score,'intent_score',OLD.intent_score,'temperature',OLD.temperature),'after',json_object('name',NEW.name,'stage',NEW.stage,'website',NEW.website,'industry',NEW.industry,'tier',NEW.tier,'territory',NEW.territory,'owner',NEW.owner,'fit_score',NEW.fit_score,'intent_score',NEW.intent_score,'temperature',NEW.temperature)),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_companies_delete` BEFORE DELETE ON `companies` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.delete','company',CAST(OLD.id AS TEXT),'Company deleted',json_object('before',json_object('name',OLD.name,'stage',OLD.stage,'owner',OLD.owner),'after',NULL),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_deals_update` AFTER UPDATE ON `deals` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','deal',CAST(NEW.id AS TEXT),'Deal changed',json_object('before',json_object('name',OLD.name,'company',OLD.company,'stage',OLD.stage,'owner',OLD.owner,'value',OLD.value,'probability',OLD.probability,'next_step',OLD.next_step,'close_date',OLD.close_date,'lead_source',OLD.lead_source,'campaign',OLD.campaign,'partner',OLD.partner,'forecast_category',OLD.forecast_category,'status',OLD.status),'after',json_object('name',NEW.name,'company',NEW.company,'stage',NEW.stage,'owner',NEW.owner,'value',NEW.value,'probability',NEW.probability,'next_step',NEW.next_step,'close_date',NEW.close_date,'lead_source',NEW.lead_source,'campaign',NEW.campaign,'partner',NEW.partner,'forecast_category',NEW.forecast_category,'status',NEW.status)),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_deals_delete` BEFORE DELETE ON `deals` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.delete','deal',CAST(OLD.id AS TEXT),'Deal deleted',json_object('before',json_object('name',OLD.name,'company',OLD.company,'stage',OLD.stage,'owner',OLD.owner,'value',OLD.value,'status',OLD.status),'after',NULL),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_tasks_update` AFTER UPDATE ON `tasks` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','task',CAST(NEW.id AS TEXT),'Task changed',json_object('before',json_object('title',OLD.title,'due_date',OLD.due_date,'owner',OLD.owner,'status',OLD.status,'completed',OLD.completed),'after',json_object('title',NEW.title,'due_date',NEW.due_date,'owner',NEW.owner,'status',NEW.status,'completed',NEW.completed)),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_campaigns_update` AFTER UPDATE ON `campaigns` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','campaign',CAST(NEW.id AS TEXT),'Campaign changed',json_object('before',json_object('name',OLD.name,'subject',OLD.subject,'status',OLD.status,'audience',OLD.audience,'recipient_count',OLD.recipient_count,'scheduled_at',OLD.scheduled_at,'sent_at',OLD.sent_at),'after',json_object('name',NEW.name,'subject',NEW.subject,'status',NEW.status,'audience',NEW.audience,'recipient_count',NEW.recipient_count,'scheduled_at',NEW.scheduled_at,'sent_at',NEW.sent_at)),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_enrollments_update` AFTER UPDATE ON `automation_enrollments` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','automation_enrollment',CAST(NEW.id AS TEXT),'Automation enrollment changed',json_object('before',json_object('current_step',OLD.current_step,'status',OLD.status,'next_run_at',OLD.next_run_at,'completed_at',OLD.completed_at,'stopped_reason',OLD.stopped_reason,'replied_at',OLD.replied_at),'after',json_object('current_step',NEW.current_step,'status',NEW.status,'next_run_at',NEW.next_run_at,'completed_at',NEW.completed_at,'stopped_reason',NEW.stopped_reason,'replied_at',NEW.replied_at)),datetime('now')); END;
--> statement-breakpoint
CREATE TRIGGER `audit_team_update` AFTER UPDATE ON `team_members` BEGIN INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('database-trigger','row.update','team_member',CAST(NEW.id AS TEXT),'Team member changed',json_object('before',json_object('email',OLD.email,'name',OLD.name,'role',OLD.role,'permissions',OLD.permissions,'active',OLD.active),'after',json_object('email',NEW.email,'name',NEW.name,'role',NEW.role,'permissions',NEW.permissions,'active',NEW.active)),datetime('now')); END;
