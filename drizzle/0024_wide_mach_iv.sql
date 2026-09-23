CREATE TABLE `custom_object_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`object_type_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`field_type` text DEFAULT 'text' NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`show_in_list` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`object_type_id`) REFERENCES `custom_object_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_object_fields_object_key_unique` ON `custom_object_fields` (`object_type_id`,`key`);--> statement-breakpoint
CREATE INDEX `custom_object_fields_object_sort_idx` ON `custom_object_fields` (`object_type_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `custom_object_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`object_type_id` text NOT NULL,
	`name` text DEFAULT 'Default' NOT NULL,
	`sections_json` text DEFAULT '[]' NOT NULL,
	`is_default` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`object_type_id`) REFERENCES `custom_object_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `custom_object_layouts_object_idx` ON `custom_object_layouts` (`object_type_id`,`is_default`);--> statement-breakpoint
CREATE TABLE `custom_object_records` (
	`id` text PRIMARY KEY NOT NULL,
	`object_type_id` text NOT NULL,
	`display_name` text NOT NULL,
	`values_json` text DEFAULT '{}' NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`object_type_id`) REFERENCES `custom_object_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `custom_object_records_object_status_idx` ON `custom_object_records` (`object_type_id`,`status`);--> statement-breakpoint
CREATE INDEX `custom_object_records_object_updated_idx` ON `custom_object_records` (`object_type_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `custom_object_types` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`singular_name` text NOT NULL,
	`plural_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text DEFAULT 'boxes' NOT NULL,
	`title_field_key` text DEFAULT 'name' NOT NULL,
	`status` text DEFAULT 'Active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_object_types_key_unique` ON `custom_object_types` (`key`);--> statement-breakpoint
CREATE INDEX `custom_object_types_status_idx` ON `custom_object_types` (`status`);--> statement-breakpoint
CREATE TABLE `custom_relationship_types` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`from_type` text NOT NULL,
	`to_type` text NOT NULL,
	`from_label` text NOT NULL,
	`to_label` text NOT NULL,
	`cardinality` text DEFAULT 'many_to_many' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `custom_relationship_types_endpoints_idx` ON `custom_relationship_types` (`from_type`,`to_type`);--> statement-breakpoint
CREATE TABLE `custom_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`relationship_type_id` text NOT NULL,
	`from_entity_type` text NOT NULL,
	`from_entity_id` text NOT NULL,
	`to_entity_type` text NOT NULL,
	`to_entity_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`relationship_type_id`) REFERENCES `custom_relationship_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_relationships_link_unique` ON `custom_relationships` (`relationship_type_id`,`from_entity_id`,`to_entity_id`);--> statement-breakpoint
CREATE INDEX `custom_relationships_from_idx` ON `custom_relationships` (`from_entity_type`,`from_entity_id`);--> statement-breakpoint
CREATE INDEX `custom_relationships_to_idx` ON `custom_relationships` (`to_entity_type`,`to_entity_id`);--> statement-breakpoint
CREATE TABLE `custom_rollup_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`object_type_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`relationship_type_id` text NOT NULL,
	`aggregate` text DEFAULT 'count' NOT NULL,
	`source_field_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`object_type_id`) REFERENCES `custom_object_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`relationship_type_id`) REFERENCES `custom_relationship_types`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_rollups_object_key_unique` ON `custom_rollup_definitions` (`object_type_id`,`key`);--> statement-breakpoint
CREATE INDEX `custom_rollups_relationship_idx` ON `custom_rollup_definitions` (`relationship_type_id`);