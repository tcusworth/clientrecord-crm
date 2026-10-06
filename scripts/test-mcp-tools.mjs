import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
sqlite.exec(`INSERT INTO team_members(email,name,role,permissions,active,created_at,updated_at) VALUES
 ('editor@example.com','Eddie','editor','{}',1,'now','now'),('viewer@example.com','Vera','viewer','{}',1,'now','now');
INSERT INTO companies(id,name,owner,updated_at) VALUES (1,'Acme','owner@example.com','now');
INSERT INTO contacts(id,first_name,last_name,email,company,notes,created_at,updated_at) VALUES (1,'Ada','Lovelace','ada@example.com','Acme','${"x".repeat(3000)}','now','now');
INSERT INTO deals(id,name,company,company_id,contact_id,stage,stage_key,pipeline_key,owner,value,next_step,status,created_at,updated_at) VALUES (1,'Acme expansion','Acme',1,1,'Proposal','Proposal','default','Owner',500000,'Send pricing','Open','now','now');
INSERT INTO deal_proposals(id,deal_id,title,status,share_token,created_by,created_at,updated_at) VALUES (1,1,'P','Sent','secret-share-token-xyz','owner@example.com','now','now');`);
const { userByEmail } = load("lib/crm-auth.ts");
const { TOOLS, callTool, sanitize } = load("mcp/src/tools.ts");
const as = async email => ({ db: env.DB, user: await userByEmail(email), client: "Test client" });
const owner = await as("owner@example.com"), editor = await as("editor@example.com"), viewer = await as("viewer@example.com");

// catalogue
const names = TOOLS.map(t => t.name).sort();
assert.deepEqual(names, ["add_note","complete_task","create_company","create_contact","create_deal","create_task","get_company","get_contact","get_deal","list_companies","list_contacts","list_deals","list_tasks","log_activity","pipeline_summary","search_crm","update_company","update_contact","update_deal"]);
for (const t of TOOLS) { assert.equal(t.inputSchema.type, "object", t.name); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.annotations.readOnlyHint, t.permission === "records.view", t.name); }
assert.ok(!names.some(n => /delete|merge|bulk|send|import/.test(n)), "no destructive tools");

// reads
const search = await callTool(viewer, "search_crm", { query: "ada" });
assert.equal(search.ok, true); assert.equal(search.result.contacts[0].email, "ada@example.com");
const contact = await callTool(viewer, "get_contact", { id: 1 });
assert.ok(contact.result.contact.notes.length <= 2001, "long text truncated");
const deal = await callTool(viewer, "get_deal", { id: 1 });
assert.equal(deal.result.deal.value, 5000);
assert.ok(!JSON.stringify(deal).includes("secret-share-token"), "no share tokens");
assert.equal((await callTool(viewer, "get_deal", { id: 999 })).status, 404);
assert.equal((await callTool(viewer, "list_deals", { limit: 500 })).result.limit, 25);
assert.ok((await callTool(viewer, "pipeline_summary", {})).result.byStage.length >= 1);

// permissions
const denied = await callTool(viewer, "create_contact", { firstName: "V", lastName: "W", email: "v@example.com" });
assert.deepEqual({ ok: denied.ok, status: denied.status }, { ok: false, status: 403 });
assert.equal((await callTool(editor, "unknown_tool", {})).status, 404);
assert.equal((await callTool(editor, "create_contact", "not an object")).status, 400);

// writes + audit attribution
const created = await callTool(editor, "create_contact", { firstName: "Grace", lastName: "Hopper", email: "grace@example.com", company: "Acme" });
assert.equal(created.ok, true);
const auditRow = sqlite.prepare("SELECT actor_email,action,changes FROM audit_logs ORDER BY id DESC LIMIT 1").get();
assert.equal(auditRow.actor_email, "editor@example.com"); assert.equal(auditRow.action, "mcp.create_contact");
assert.deepEqual({ via: JSON.parse(auditRow.changes).via, client: JSON.parse(auditRow.changes).client }, { via: "mcp", client: "Test client" });
const dup = await callTool(editor, "create_contact", { firstName: "G", lastName: "H", email: "grace@example.com" });
assert.deepEqual({ ok: dup.ok, status: dup.status }, { ok: false, status: 409 });
const upd = await callTool(editor, "update_contact", { id: created.result.id, title: "Rear Admiral" });
assert.equal(upd.ok, true);
assert.deepEqual({ ...sqlite.prepare("SELECT first_name,title,email FROM contacts WHERE id=?").get(created.result.id) }, { first_name: "Grace", title: "Rear Admiral", email: "grace@example.com" }, "partial update keeps other fields");
const moved = await callTool(editor, "update_deal", { id: 1, stage: "Won", closedReason: "Signed" });
assert.equal(moved.ok, true); assert.equal(sqlite.prepare("SELECT status FROM deals WHERE id=1").get().status, "Won");
assert.equal((await callTool(editor, "update_deal", { id: 1, stage: "Nope" })).status, 400);
assert.equal((await callTool(editor, "add_note", { recordType: "deal", id: 1, note: "CFO signed" })).ok, true);
assert.equal((await callTool(editor, "add_note", { recordType: "company", id: 1, note: "Renewal in May" })).ok, true);
assert.equal((await callTool(editor, "add_note", { recordType: "contact", id: 1, note: "Prefers email" })).ok, true);
assert.equal((await callTool(editor, "log_activity", { recordType: "contact", id: 1, type: "Call", details: "Intro call" })).ok, true);
assert.equal((await callTool(editor, "log_activity", { recordType: "deal", id: 1, type: "Meeting", details: "Pricing review" })).ok, true);
const task = await callTool(editor, "create_task", { recordType: "contact", id: 1, title: "Send deck", dueDate: "2026-10-01" });
assert.equal(task.ok, true);
assert.equal((await callTool(editor, "complete_task", { taskType: "contact", id: task.result.id })).ok, true);
assert.equal((await callTool(editor, "complete_task", { taskType: "contact", id: 99999 })).status, 404);
const co = await callTool(editor, "create_company", { name: "Globex" });
assert.equal(co.ok, true); assert.equal(sqlite.prepare("SELECT owner FROM companies WHERE id=?").get(co.result.id).owner, "editor@example.com", "owner defaults to caller");
const nd = await callTool(owner, "create_deal", { name: "Globex pilot", companyId: co.result.id, value: 1200, nextStep: "Scope call" });
assert.equal(nd.ok, true); assert.equal(sqlite.prepare("SELECT stage,value FROM deals WHERE id=?").get(nd.result.id).value, 120000);


// controller rulings: date validation before any write, friendly 404s for linked ids, merging partial company/contact updates
const before = sqlite.prepare("SELECT (SELECT count(*) FROM activities) AS a,(SELECT count(*) FROM deal_activities) AS d,(SELECT count(*) FROM tasks) AS t,(SELECT count(*) FROM deal_tasks) AS dt").get();
for (const followUpDate of ["2026-02-31", "next week", "2026-1-5"]) {
  assert.equal((await callTool(editor, "log_activity", { recordType: "deal", id: 1, type: "Call", details: "x", followUpDate })).status, 400, followUpDate);
  assert.equal((await callTool(editor, "log_activity", { recordType: "contact", id: 1, type: "Call", details: "x", followUpDate })).status, 400, followUpDate);
}
assert.equal((await callTool(editor, "log_activity", { recordType: "contact", id: 1, type: "Call", details: "x", happenedAt: "yesterday-ish" })).status, 400);
assert.deepEqual({ ...sqlite.prepare("SELECT (SELECT count(*) FROM activities) AS a,(SELECT count(*) FROM deal_activities) AS d,(SELECT count(*) FROM tasks) AS t,(SELECT count(*) FROM deal_tasks) AS dt").get() }, { ...before }, "invalid dates write nothing");
assert.equal((await callTool(editor, "log_activity", { recordType: "deal", id: 1, type: "Call", details: "Follow-up call", followUpDate: "2026-11-02" })).ok, true);
assert.equal(sqlite.prepare("SELECT due_date FROM deal_tasks ORDER BY id DESC LIMIT 1").get().due_date, "2026-11-02");
const badContact = await callTool(owner, "create_deal", { name: "Ghost", value: 1, nextStep: "x", contactId: 4242 });
assert.deepEqual({ status: badContact.status, error: badContact.error }, { status: 404, error: "Contact not found." });
const badCompany = await callTool(owner, "update_deal", { id: nd.result.id, companyId: 4242 });
assert.deepEqual({ status: badCompany.status, error: badCompany.error }, { status: 404, error: "Company not found." });
sqlite.prepare("UPDATE companies SET tags='[\"vip\"]',fit_score=70,fit_reason='Great fit',headquarters='Springfield',linkedin_url='https://linkedin.com/x',logo_url='https://logo/x.png',employee_range='51-200',primary_contact_id=1,industry='Widgets',website='https://acme.test' WHERE id=1").run();
assert.equal((await callTool(editor, "update_company", { id: 1, tier: "A" })).ok, true);
assert.deepEqual({ ...sqlite.prepare("SELECT tier,tags,fit_score,fit_reason,headquarters,linkedin_url,logo_url,employee_range,primary_contact_id,industry,website,owner,name FROM companies WHERE id=1").get() }, { tier: "A", tags: '["vip"]', fit_score: 70, fit_reason: "Great fit", headquarters: "Springfield", linkedin_url: "https://linkedin.com/x", logo_url: "https://logo/x.png", employee_range: "51-200", primary_contact_id: 1, industry: "Widgets", website: "https://acme.test", owner: "owner@example.com", name: "Acme" }, "partial company update keeps every other column");
sqlite.prepare("UPDATE contacts SET phone='555',location='Paris',lead_source='Referral',tags='[\"a\"]',notes='keep me' WHERE id=?").run(created.result.id);
assert.equal((await callTool(editor, "update_contact", { id: created.result.id, stage: "Customer" })).ok, true);
assert.deepEqual({ ...sqlite.prepare("SELECT stage,phone,location,lead_source,tags,notes,company FROM contacts WHERE id=?").get(created.result.id) }, { stage: "Customer", phone: "555", location: "Paris", lead_source: "Referral", tags: '["a"]', notes: "keep me", company: "Acme" }, "partial contact update keeps lead source, tags and notes");
assert.equal((await callTool(viewer, "get_company", { id: 999 })).status, 404);

// sanitize
assert.deepEqual(sanitize({ a: "b", share_token: "x", apiKeyHash: "y", nested: [{ password: "p", ok: 1 }] }), { a: "b", nested: [{ ok: 1 }] });
console.log("PASS: MCP tools — catalogue, reads, permissions, writes, audit attribution, sanitising");
