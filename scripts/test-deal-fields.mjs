import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSqlite, migrationFiles, projectRoot } from "./test-helpers.mjs";

// 0029 migration: four CSI deal select fields plus an idempotent backfill keyed on pipeline_key='csi' and deal name.
const MIGRATION = "0029_csi_deal_fields.sql", migrationSql = fs.readFileSync(path.join(projectRoot, "drizzle", MIGRATION), "utf8");
const before = migrationFiles().filter(file => file < MIGRATION);
const db = createSqlite({ migrations: before });
db.exec(`INSERT INTO deals(id,name,company,stage,stage_key,pipeline_key,owner,value,next_step,status,created_at,updated_at) VALUES
 (1,'Toggle Eng Demo System','Toggle','Demo','demo','csi','Owner',0,'Demo','Open','now','now'),
 (2,'Reliance Test Bed 2','Reliance','Demo','demo','csi','Owner',0,'Test','Open','now','now'),
 (3,'Reliance Test Bed 2','Reliance','Demo','demo','default','Owner',0,'Not CSI','Open','now','now');
INSERT INTO custom_field_definitions(id,entity_type,name,field_key,field_type,options,created_at) VALUES (50,'contact','Deal type','deal_type','text','[]','now');`);
db.exec(migrationSql);
const defs = db.prepare("SELECT name,field_key AS key,field_type AS type,options FROM custom_field_definitions WHERE entity_type='deal' ORDER BY id").all().map(d => ({ ...d, options: JSON.parse(d.options) }));
assert.deepEqual(defs, [
  { name: "Deal type", key: "deal_type", type: "select", options: ["OPA Assessment", "OPA Roadmap", "COPA Demo", "Consulting", "Integration", "Training", "Support", "Partner Opportunity", "Other"] },
  { name: "Business driver", key: "business_driver", type: "select", options: ["DCS Obsolescence", "Lifecycle Cost", "Vendor Lock-In", "Modernization", "Advanced Control", "Cybersecurity", "Downtime Reduction", "Capital Project", "Standardization", "Workforce/Skills"] },
  { name: "Technical driver", key: "technical_driver", type: "select", options: ["Interoperability", "Portability", "Open Architecture", "Hardware/Software Decoupling", "Multi-vendor System", "Edge Control", "Application Reuse", "Lifecycle Flexibility"] },
  { name: "Source campaign", key: "source_campaign", type: "select", options: ["LinkedIn", "ROI Calculator", "OPA Advisor", "OPA Community", "ARC Forum", "OPAF", "Webinar", "Referral", "Direct Outreach", "Other"] },
]);
const values = () => db.prepare("SELECT v.entity_id AS deal,f.field_key AS key,v.value FROM custom_field_values v JOIN custom_field_definitions f ON f.id=v.definition_id WHERE v.entity_type='deal' ORDER BY v.entity_id,f.id").all().map(r => ({ ...r }));
const expected = [{ deal: 1, key: "deal_type", value: "COPA Demo" }, { deal: 2, key: "deal_type", value: "COPA Demo" }, { deal: 2, key: "business_driver", value: "Modernization" }, { deal: 2, key: "technical_driver", value: "Interoperability" }, { deal: 2, key: "source_campaign", value: "Referral" }];
assert.deepEqual(values(), expected, "backfill only touches the named CSI deals");
// Re-running the statements is a no-op and never overwrites a value someone set since.
db.exec("UPDATE custom_field_values SET value='Training' WHERE entity_id=1");
db.exec(migrationSql);
assert.equal(db.prepare("SELECT count(*) AS n FROM custom_field_definitions WHERE entity_type='deal'").get().n, 4);
assert.deepEqual(values(), [{ ...expected[0], value: "Training" }, ...expected.slice(1)]);
assert.equal(db.prepare("SELECT field_type FROM custom_field_definitions WHERE id=50").get().field_type, "text", "other entity types untouched");
// A database without the CSI deals (or with all migrations, as the other test files use) still migrates cleanly.
assert.equal(createSqlite().prepare("SELECT count(*) AS n FROM custom_field_definitions WHERE entity_type='deal'").get().n, 4);

console.log("deal custom field tests passed");
