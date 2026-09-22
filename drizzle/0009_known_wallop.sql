CREATE TABLE `ai_artifact_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artifact_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_updated_at` text,
	`content_hash` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `ai_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_artifact_source_unique` ON `ai_artifact_sources` (`artifact_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `ai_artifact_sources_artifact` ON `ai_artifact_sources` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `ai_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`feature` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`review_status` text DEFAULT 'Draft' NOT NULL,
	`content_json` text NOT NULL,
	`original_content_json` text NOT NULL,
	`explanation` text DEFAULT '' NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` integer,
	`rules_version` text DEFAULT '' NOT NULL,
	`input_hash` text NOT NULL,
	`generated_by` text NOT NULL,
	`generated_at` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`superseded_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_artifacts_entity_date` ON `ai_artifacts` (`entity_type`,`entity_id`,`generated_at`);--> statement-breakpoint
CREATE INDEX `ai_artifacts_status_date` ON `ai_artifacts` (`review_status`,`generated_at`);--> statement-breakpoint
CREATE TABLE `ai_feedback_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artifact_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text DEFAULT '{}' NOT NULL,
	`after_json` text DEFAULT '{}' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `ai_artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ai_feedback_artifact_date` ON `ai_feedback_events` (`artifact_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`feature` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`system_prompt` text NOT NULL,
	`response_schema` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'Draft' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`activated_by` text,
	`activated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_prompt_feature_version` ON `ai_prompt_versions` (`feature`,`version`);--> statement-breakpoint
CREATE INDEX `ai_prompt_feature_status` ON `ai_prompt_versions` (`feature`,`status`);--> statement-breakpoint
CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`feature` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` integer,
	`input_hash` text NOT NULL,
	`requested_by` text NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`input_chars` integer DEFAULT 0 NOT NULL,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`estimated_tokens` integer DEFAULT 0 NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `ai_runs_user_date` ON `ai_runs` (`requested_by`,`started_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_feature_date` ON `ai_runs` (`feature`,`started_at`);--> statement-breakpoint
CREATE INDEX `ai_runs_status_date` ON `ai_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'openai' NOT NULL,
	`model` text DEFAULT 'gpt-5-mini' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`daily_run_limit` integer DEFAULT 100 NOT NULL,
	`per_user_daily_limit` integer DEFAULT 25 NOT NULL,
	`max_context_chars` integer DEFAULT 60000 NOT NULL,
	`result_retention_days` integer DEFAULT 730 NOT NULL,
	`require_review` integer DEFAULT true NOT NULL,
	`allow_sensitive_sources` integer DEFAULT false NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
