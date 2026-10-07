import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSqlite, migrationFiles, projectRoot } from "./test-helpers.mjs";

// 0030 migration: delete the leftover "Test" deal of the retired built-in pipeline plus everything attached to it, and nothing else.
const MIGRATION = "0030_remove_test_deal.sql", migrationSql = fs.readFileSync(path.join(projectRoot, "drizzle", MIGRATION), "utf8");
const db = createSqlite({ migrations: migrationFiles().filter(file => file < MIGRATION) });
const q = sql => db.prepare(sql).all().map(r => ({ ...r })), n = sql => q(sql)[0].n;
let seq = 0;
// Generic seeder: fills NOT NULL columns without defaults, recursively inserting parent rows for NOT NULL foreign keys.
function insert(table, over = {}) {
  const fks = Object.fromEntries(q(`PRAGMA foreign_key_list(\`${table}\`)`).map(f => [f.from, f.table])), cols = {};
  for (const c of q(`PRAGMA table_info(\`${table}\`)`)) {
    if (c.name in over) cols[c.name] = over[c.name];
    else if (c.pk && c.type.toUpperCase() === "INTEGER") continue;
    else if (c.notnull && (c.dflt_value === null || (c.dflt_value === "''" && !fks[c.name]))) cols[c.name] = fks[c.name] ? insert(fks[c.name]) : /INT/i.test(c.type) ? 0 : `x${++seq}`;
  }
  const names = Object.keys(cols), res = db.prepare(`INSERT INTO \`${table}\`(${names.map(c => `\`${c}\``).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(cols));
  return cols.id ?? Number(res.lastInsertRowid);
}
const deal = (id, name, pipeline) => insert("deals", { id, name, pipeline_key: pipeline, stage: "Qualified", stage_key: "q", owner: "o", status: "Open" });
// Target: id 1 (default/Test). Controls: id 2 (csi/Test), id 3 (default/Real).
deal(1, "Test", "default"); deal(2, "Test", "csi"); deal(3, "Real", "default");
const seedAll = d => {
  const proposal = insert("deal_proposals", { deal_id: d }), doc = insert("client_documents", { deal_id: d }), activity = insert("deal_activities", { deal_id: d });
  const meeting = insert("deal_meetings", { deal_id: d, transcript_document_id: doc, activity_id: activity }), task = insert("deal_tasks", { deal_id: d });
  insert("proposal_acceptances", { proposal_id: proposal }); insert("proposal_share_events", { proposal_id: proposal });
  insert("quickbooks_invoices", { deal_id: d, proposal_id: proposal }); insert("document_versions", { document_id: doc });
  insert("deal_meeting_attendees", { meeting_id: meeting }); insert("deal_recommendations", { deal_id: d, task_id: task });
  for (const t of ["deal_stage_history", "deal_insights", "deal_line_items", "deal_notes", "deal_reviews", "deal_stakeholders", "deal_relationship_health_scores", "deal_competitors"]) insert(t, { deal_id: d });
  const referral = insert("partner_referrals", { deal_id: d }), inbox = insert("inbox_messages", { deal_id: d });
  insert("partner_payouts", { deal_id: d, referral_id: referral }); insert("service_cases", { deal_id: d, inbox_message_id: inbox });
  insert("meetily_webhook_events", { deal_id: d, meeting_id: meeting }); insert("sync_records", { deal_id: d }); insert("communication_review_items", { deal_id: d });
  insert("customer_success_plans", { renewal_deal_id: d });
  const def = insert("custom_field_definitions", { entity_type: "deal", field_key: `k${d}` });
  insert("custom_field_values", { definition_id: def, entity_type: "deal", entity_id: d }); insert("ai_record_fields", { entity_type: "deal", entity_id: String(d) });
  insert("custom_relationships", { from_entity_type: "deal", from_entity_id: String(d), to_entity_type: "company", to_entity_id: "9" });
};
for (const d of [1, 2, 3]) seedAll(d);
// Owned child rows: deleted for deal 1. Referencing rows: kept, reference NULLed.
const owned = ["deal_stage_history", "deal_tasks", "client_documents", "deal_activities", "deal_insights", "deal_line_items", "deal_notes", "deal_proposals", "deal_reviews", "deal_stakeholders", "deal_relationship_health_scores", "deal_recommendations", "deal_meetings", "deal_competitors", "quickbooks_invoices"];
const nulled = [["sync_records", "deal_id"], ["inbox_messages", "deal_id"], ["customer_success_plans", "renewal_deal_id"], ["partner_payouts", "deal_id"], ["partner_referrals", "deal_id"], ["service_cases", "deal_id"], ["communication_review_items", "deal_id"], ["meetily_webhook_events", "deal_id"]];
const grandchildren = [["proposal_acceptances", "deal_proposals"], ["proposal_share_events", "deal_proposals"], ["deal_meeting_attendees", "deal_meetings"], ["document_versions", "client_documents"]];
const count = (t, c, d) => n(`SELECT count(*) n FROM \`${t}\` WHERE \`${c}\`=${d}`);
const total = t => n(`SELECT count(*) n FROM \`${t}\``);
for (const t of owned) assert.equal(count(t, "deal_id", 1), 1, `${t} seeded for deal 1`);
const before = Object.fromEntries([...owned, ...nulled.map(x => x[0]), ...grandchildren.map(x => x[0]), "custom_field_values", "ai_record_fields", "custom_relationships"].map(t => [t, total(t)]));

db.exec(migrationSql);

assert.equal(n("SELECT count(*) n FROM deals WHERE id=1"), 0, "default/Test deal deleted");
assert.deepEqual(q("SELECT id FROM deals ORDER BY id").map(r => r.id), [2, 3], "csi/Test and default/Real untouched");
for (const t of owned) { assert.equal(count(t, "deal_id", 1), 0, `${t}: deal 1 rows deleted`); assert.equal(count(t, "deal_id", 2), 1, `${t}: csi Test kept`); assert.equal(count(t, "deal_id", 3), 1, `${t}: other deal kept`); assert.equal(total(t), before[t] - 1, `${t}: exactly one row removed`); }
for (const [t] of grandchildren) assert.equal(total(t), before[t] - 1, `${t}: grandchild rows removed with their parent`);
for (const [t, c] of nulled) { assert.equal(total(t), before[t], `${t}: owner rows kept`); assert.equal(count(t, c, 1), 0, `${t}.${c}: reference to deal 1 cleared`); assert.equal(count(t, c, 2), 1, `${t}.${c}: csi Test reference kept`); assert.equal(count(t, c, 3), 1, `${t}.${c}: other deal reference kept`); }
assert.equal(n("SELECT count(*) n FROM meetily_webhook_events WHERE meeting_id IS NULL"), 1, "webhook event detached from the deleted meeting");
assert.equal(n("SELECT count(*) n FROM custom_field_values WHERE entity_type='deal' AND entity_id=1"), 0);
assert.equal(total("custom_field_values"), before.custom_field_values - 1);
assert.equal(n("SELECT count(*) n FROM ai_record_fields WHERE entity_type='deal' AND entity_id='1'"), 0);
assert.equal(total("ai_record_fields"), before.ai_record_fields - 1);
assert.equal(n("SELECT count(*) n FROM custom_relationships WHERE from_entity_id='1'"), 0);
assert.equal(total("custom_relationships"), before.custom_relationships - 1);
const snapshot = JSON.stringify(Object.fromEntries(q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r => [r.name, total(r.name)])));
db.exec(migrationSql);
assert.equal(JSON.stringify(Object.fromEntries(q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r => [r.name, total(r.name)]))), snapshot, "idempotent: second run changes nothing");
assert.equal(q("PRAGMA foreign_key_check").length, 0, "no orphaned foreign keys");

// Production shape: only the Test deal and 9 history rows; running against a DB with no Test deal at all is a no-op.
const empty = createSqlite({ migrations: migrationFiles().filter(file => file < MIGRATION) });
empty.exec("INSERT INTO deals(id,name,pipeline_key,stage,stage_key,owner,status,created_at,updated_at) VALUES (1,'Test','default','Qualified','q','o','Open','now','now'),(2,'Acme','csi','Target','target','o','Open','now','now')");
for (let i = 0; i < 9; i++) empty.exec(`INSERT INTO deal_stage_history(deal_id,from_stage,to_stage,from_pipeline,to_pipeline,reason,actor,happened_at) VALUES (1,'a','b','','default','','o','now')`);
empty.exec(migrationSql);
assert.equal(empty.prepare("SELECT count(*) n FROM deals").get().n, 1); assert.equal(empty.prepare("SELECT count(*) n FROM deal_stage_history").get().n, 0);
assert.equal(empty.prepare("PRAGMA foreign_key_check").all().length, 0);
console.log("PASS: Test deal removal");
