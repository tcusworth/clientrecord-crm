-- Data-only: remove the leftover "Test" deal of the retired built-in pipeline with everything attached to it (owned rows deleted children-first;
-- rows that only reference it, e.g. inbox messages, service cases, partner records, have the reference cleared). Idempotent: matches nothing once the deal is gone.
DELETE FROM `proposal_acceptances` WHERE `proposal_id` IN (SELECT `id` FROM `deal_proposals` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
DELETE FROM `proposal_share_events` WHERE `proposal_id` IN (SELECT `id` FROM `deal_proposals` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
DELETE FROM `quickbooks_invoices` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test') OR `proposal_id` IN (SELECT `id` FROM `deal_proposals` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
UPDATE `meetily_webhook_events` SET `meeting_id`=NULL WHERE `meeting_id` IN (SELECT `id` FROM `deal_meetings` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
UPDATE `meetily_webhook_events` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_meeting_attendees` WHERE `meeting_id` IN (SELECT `id` FROM `deal_meetings` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
DELETE FROM `deal_meetings` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_proposals` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_recommendations` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_tasks` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_activities` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `document_versions` WHERE `document_id` IN (SELECT `id` FROM `client_documents` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
DELETE FROM `client_documents` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_insights` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_line_items` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_notes` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_reviews` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_stakeholders` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_relationship_health_scores` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_competitors` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `deal_stage_history` WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `sync_records` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `inbox_messages` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `customer_success_plans` SET `renewal_deal_id`=NULL WHERE `renewal_deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `partner_payouts` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `partner_referrals` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `service_cases` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
UPDATE `communication_review_items` SET `deal_id`=NULL WHERE `deal_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `custom_field_values` WHERE `entity_type`='deal' AND `entity_id` IN (SELECT `id` FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `ai_record_fields` WHERE `entity_type`='deal' AND `entity_id` IN (SELECT CAST(`id` AS TEXT) FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test');
--> statement-breakpoint
DELETE FROM `custom_relationships` WHERE (`from_entity_type`='deal' AND `from_entity_id` IN (SELECT CAST(`id` AS TEXT) FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test')) OR (`to_entity_type`='deal' AND `to_entity_id` IN (SELECT CAST(`id` AS TEXT) FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test'));
--> statement-breakpoint
DELETE FROM `deals` WHERE `pipeline_key`='default' AND `name`='Test';
