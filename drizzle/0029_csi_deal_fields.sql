-- Data-only: the CSI team's four Attio deal select fields (no schema change). Idempotent: definitions are keyed on the unique (entity_type,field_key),
-- and the backfill only fills a value when the CSI deal and field exist, the option is configured, and no value is set yet.
INSERT OR IGNORE INTO `custom_field_definitions`(`entity_type`,`name`,`field_key`,`field_type`,`options`,`created_at`) VALUES
 ('deal','Deal type','deal_type','select','["OPA Assessment","OPA Roadmap","COPA Demo","Consulting","Integration","Training","Support","Partner Opportunity","Other"]',datetime('now')),
 ('deal','Business driver','business_driver','select','["DCS Obsolescence","Lifecycle Cost","Vendor Lock-In","Modernization","Advanced Control","Cybersecurity","Downtime Reduction","Capital Project","Standardization","Workforce/Skills"]',datetime('now')),
 ('deal','Technical driver','technical_driver','select','["Interoperability","Portability","Open Architecture","Hardware/Software Decoupling","Multi-vendor System","Edge Control","Application Reuse","Lifecycle Flexibility"]',datetime('now')),
 ('deal','Source campaign','source_campaign','select','["LinkedIn","ROI Calculator","OPA Advisor","OPA Community","ARC Forum","OPAF","Webinar","Referral","Direct Outreach","Other"]',datetime('now'));--> statement-breakpoint
WITH backfill(`deal_name`,`field_key`,`value`) AS (VALUES ('Toggle Eng Demo System','deal_type','COPA Demo'),('Reliance Test Bed 2','deal_type','COPA Demo'),('Reliance Test Bed 2','business_driver','Modernization'),('Reliance Test Bed 2','technical_driver','Interoperability'),('Reliance Test Bed 2','source_campaign','Referral'))
INSERT INTO `custom_field_values`(`definition_id`,`entity_type`,`entity_id`,`value`,`updated_at`)
 SELECT f.`id`,'deal',d.`id`,b.`value`,datetime('now') FROM backfill b
 JOIN `deals` d ON d.`pipeline_key`='csi' AND d.`name`=b.`deal_name`
 JOIN `custom_field_definitions` f ON f.`entity_type`='deal' AND f.`field_key`=b.`field_key`
 WHERE EXISTS(SELECT 1 FROM json_each(f.`options`) o WHERE o.`value`=b.`value`)
 AND NOT EXISTS(SELECT 1 FROM `custom_field_values` v WHERE v.`definition_id`=f.`id` AND v.`entity_type`='deal' AND v.`entity_id`=d.`id`);
