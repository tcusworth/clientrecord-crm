import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

// deleteContact must clear every reference to the contact (derived from the schema, so a new referencing table without seed data fails here):
// pure link rows are deleted, history and independent records are kept and detached (contact_id=NULL).
const { sqlite, load } = createTestContext();
const owner = "owner@example.com", editor = "editor@example.com", viewer = "viewer@example.com";
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const crm = load("app/api/crm/route.ts");
const post = (email, body) => crm.POST(new Request("https://crm.example.com/api/crm", { method: "POST", headers: headers(email), body: JSON.stringify(body) }));
async function expectStatus(promise, status, label) { const response = await promise, body = await response.clone().json().catch(() => ({})); assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`); return body; }

sqlite.exec(`
INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('${editor}','Eddie','editor','{}','now','now'),('${viewer}','Vera','viewer','{}','now','now');
INSERT INTO companies(id,name,updated_at) VALUES (1,'Acme','now');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Keep','Me','keep@acme.test','Acme','now','now'),(3,'Dana','Gone','dana@acme.test','Acme','now','now');
UPDATE companies SET primary_contact_id=3 WHERE id=1;
INSERT INTO deals(id,name,company,company_id,contact_id,stage,status,created_at,updated_at) VALUES (1,'Acme deal','Acme',1,3,'Lead','Open','now','now');
INSERT INTO automation_sequences(id,name,created_at,updated_at) VALUES (1,'Seq','now','now');
INSERT INTO partner_companies(id,name,owner,created_at,updated_at) VALUES ('p1','Partner','${owner}','now','now');
INSERT INTO custom_field_definitions(id,entity_type,name,field_key,field_type,options,created_at) VALUES (1,'contact','Tier','tier','text','[]','now');
INSERT INTO custom_relationship_types(id,name,from_type,to_type,from_label,to_label,created_by,created_at,updated_at) VALUES ('rt','Knows','contact','company','knows','known by','${owner}','now','now');
INSERT INTO activities(contact_id,type,note,happened_at) VALUES (3,'Call','call','now'),(1,'Call','keep call','now');
INSERT INTO tasks(id,contact_id,title,due_date) VALUES (10,3,'Task','2026-10-01');
INSERT INTO automation_enrollments(sequence_id,contact_id,next_run_at,enrolled_at) VALUES (1,3,'now','now');
INSERT INTO sync_records(provider,external_id,item_type,contact_id,occurred_at,created_at) VALUES ('google','x1','email',3,'now','now');
INSERT INTO account_stakeholders(company_id,contact_id,role,notes) VALUES (1,3,'Buyer',''),(1,1,'Champion','');
INSERT INTO client_documents(id,company_id,deal_id,contact_id,title,category,status,sensitive,latest_version,created_by,created_at,updated_at) VALUES ('doc-1',1,1,3,'Contract','Contract','Active',0,1,'${owner}','now','now');
INSERT INTO deal_activities(deal_id,contact_id,type,body,owner,happened_at,created_at,updated_at) VALUES (1,3,'Call','b','${owner}','now','now','now');
INSERT INTO deal_stakeholders(deal_id,contact_id,role,notes,is_primary,active,created_at,updated_at) VALUES (1,3,'Economic Buyer','',1,1,'now','now');
INSERT INTO deal_meetings(id,deal_id,company_id,subject,status,starts_at,owner,created_by,created_at,updated_at) VALUES ('meet-1',1,1,'Kickoff','Completed','now','${owner}','${owner}','now','now');
INSERT INTO deal_meeting_attendees(meeting_id,contact_id,name,email,created_at) VALUES ('meet-1',3,'Dana Gone','dana@acme.test','now');
INSERT INTO inbox_messages(id,from_email,contact_id,task_id,occurred_at,created_at,updated_at) VALUES ('in-1','dana@acme.test',3,10,'now','now','now');
INSERT INTO lead_intakes(id,email,contact_id,duplicate_contact_id,task_id,received_at) VALUES ('lead-1','dana@acme.test',3,3,10,'now');
INSERT INTO customer_portal_access(id,company_id,contact_id,token_hash,created_at) VALUES ('pa-1',1,3,'hash-1','now'),('pa-keep',1,1,'hash-keep','now');
INSERT INTO field_captures(id,type,contact_id,captured_by,captured_at) VALUES ('fc-1','Quick note',3,'${owner}','now');
INSERT INTO partner_contacts(id,partner_company_id,contact_id,first_name,last_name,email,created_at,updated_at) VALUES ('pc-1','p1',3,'Dana','Gone','dana-partner@acme.test','now','now');
INSERT INTO service_cases(id,case_number,subject,contact_id,created_at,updated_at) VALUES ('case-1','CR-1','Help',3,'now','now');
INSERT INTO communication_review_items(id,source,contact_id,created_at) VALUES ('cri-1','google',3,'now');
INSERT INTO custom_field_values(definition_id,entity_type,entity_id,value,updated_at) VALUES (1,'contact',3,'Gold','now');
INSERT INTO ai_record_fields(id,entity_type,entity_id,field_key,value_json,updated_by,updated_at) VALUES ('arf-1','contact','3','persona','"VP"','${owner}','now');
INSERT INTO custom_relationships(id,relationship_type_id,from_entity_type,from_entity_id,to_entity_type,to_entity_id,created_by,created_at) VALUES ('rel-1','rt','contact','3','company','1','${owner}','now');
`);

const contactRefs = sqlite.prepare("SELECT m.name AS tbl,f.\"from\" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f.\"table\"='contacts'").all();
const links = [["custom_field_values", "entity_type='contact' AND entity_id=?"], ["ai_record_fields", "entity_type='contact' AND entity_id=?"], ["custom_relationships", "(from_entity_type='contact' AND from_entity_id=?) OR (to_entity_type='contact' AND to_entity_id=?)"]];
const refsTo = id => [...contactRefs.map(({ tbl, col }) => [`${tbl}.${col}`, sqlite.prepare(`SELECT count(*) AS n FROM "${tbl}" WHERE "${col}"=?`).get(id).n]), ...links.map(([tbl, where]) => [tbl, sqlite.prepare(`SELECT count(*) AS n FROM ${tbl} WHERE ${where}`).get(...(where.includes("to_entity_id") ? [String(id), String(id)] : [String(id)])).n])];
for (const [ref, n] of refsTo(3)) assert.ok(n > 0, `test seeds a reference in ${ref} (add seed data for new tables that reference contacts)`);

await expectStatus(post(viewer, { action: "deleteContact", id: 3 }), 403, "viewer delete");
await expectStatus(post(editor, { action: "deleteContact", id: 3 }), 403, "editor delete");
assert.ok(sqlite.prepare("SELECT id FROM contacts WHERE id=3").get(), "forbidden deletes changed nothing");
await expectStatus(post(owner, { action: "deleteContact", id: 999 }), 404, "missing contact");

await expectStatus(post(owner, { action: "deleteContact", id: 3 }), 200, "owner delete");
assert.equal(sqlite.prepare("SELECT id FROM contacts WHERE id=3").get(), undefined, "contact deleted");
assert.deepEqual(refsTo(3).filter(([, n]) => n > 0), [], "no references to the deleted contact remain");
assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), [], "FK integrity");

// History and independent records survive, detached from the deleted contact.
for (const [tbl, where] of [["companies", "id=1"], ["deals", "id=1"], ["sync_records", "external_id='x1'"], ["client_documents", "id='doc-1'"], ["deal_activities", "deal_id=1"], ["deal_meeting_attendees", "meeting_id='meet-1'"], ["inbox_messages", "id='in-1'"], ["lead_intakes", "id='lead-1'"], ["field_captures", "id='fc-1'"], ["partner_contacts", "id='pc-1'"], ["service_cases", "id='case-1'"], ["communication_review_items", "id='cri-1'"]])
  assert.ok(sqlite.prepare(`SELECT 1 FROM ${tbl} WHERE ${where}`).get(), `${tbl} row kept`);
assert.deepEqual({ ...sqlite.prepare("SELECT contact_id AS c,duplicate_contact_id AS d,task_id AS t FROM lead_intakes WHERE id='lead-1'").get() }, { c: null, d: null, t: null }, "lead intake detached from contact and its deleted task");
assert.equal(sqlite.prepare("SELECT task_id AS t FROM inbox_messages WHERE id='in-1'").get().t, null, "inbox message detached from the deleted task");
assert.equal(sqlite.prepare("SELECT name FROM deal_meeting_attendees WHERE meeting_id='meet-1'").get().name, "Dana Gone", "attendee name kept");
// Link rows for the deleted contact are removed; other contacts' rows are untouched.
for (const tbl of ["activities", "tasks", "automation_enrollments", "account_stakeholders", "deal_stakeholders", "customer_portal_access"])
  assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM ${tbl} WHERE contact_id=3`).get().n, 0, `${tbl} rows removed`);
assert.ok(sqlite.prepare("SELECT 1 FROM activities WHERE contact_id=1").get(), "other contact's activity kept");
assert.ok(sqlite.prepare("SELECT 1 FROM account_stakeholders WHERE contact_id=1").get(), "other contact's stakeholder kept");
assert.ok(sqlite.prepare("SELECT 1 FROM customer_portal_access WHERE id='pa-keep'").get(), "other contact's portal link kept");

console.log("PASS: deleteContact clears every contact reference, keeps history detached, and requires records.delete.");
