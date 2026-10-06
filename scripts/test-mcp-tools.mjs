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
const ps = (await callTool(viewer, "pipeline_summary", {})).result;
assert.deepEqual(ps.byPipeline.map(p => ({ ...p.pipeline, stages: p.stages })), [{ id: "default", name: "New business", stages: [{ stage: "Proposal", count: 1, value: 5000 }] }]);
assert.equal(ps.openValue, 5000);

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

// final fix wave: notes can only be added (add_note), never replaced; unknown keys rejected; strict integer ids
const companyNotes = sqlite.prepare("SELECT notes FROM companies WHERE id=1").get().notes;
const viaContact = await callTool(editor, "update_contact", { id: created.result.id, notes: "wiped" });
assert.deepEqual({ ok: viaContact.ok, status: viaContact.status }, { ok: false, status: 400 }, "update_contact rejects notes");
const viaCompany = await callTool(editor, "update_company", { id: 1, notes: "wiped" });
assert.deepEqual({ ok: viaCompany.ok, status: viaCompany.status }, { ok: false, status: 400 }, "update_company rejects notes");
assert.equal(sqlite.prepare("SELECT notes FROM contacts WHERE id=?").get(created.result.id).notes, "keep me", "contact notes unchanged");
assert.equal(sqlite.prepare("SELECT notes FROM companies WHERE id=1").get().notes, companyNotes, "company notes unchanged");
for (const t of TOOLS.filter(t => t.name === "update_contact" || t.name === "update_company")) assert.ok(!("notes" in t.inputSchema.properties), `${t.name} does not advertise notes`);
assert.equal((await callTool(viewer, "get_contact", { id: 1, surprise: 1 })).status, 400, "unknown keys rejected");
for (const bad of [true, [1], "1e2", 1.5, 0, "-1"]) assert.equal((await callTool(viewer, "get_contact", { id: bad })).status, 400, `id ${JSON.stringify(bad)}`);
assert.equal((await callTool(viewer, "get_contact", { id: "1" })).ok, true, "digit strings still accepted");

// follow-ups A1: create_deal picks a pipeline (first saved by rowid when omitted) and matches stage within it
const stages = (...names) => JSON.stringify([...names.map((n, i) => ({ key: n.toLowerCase(), name: n, probability: 10 * (i + 1), kind: "Open" })), { key: "won", name: "Won", probability: 100, kind: "Won" }, { key: "lost", name: "Lost", probability: 0, kind: "Lost" }]);
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES (?,?,?,'now')").run("csi", "CSI pipeline", stages("Target", "Proposal"));
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES (?,?,?,'now')").run("aard", "Aardvark pipeline", stages("Intro"));
const firstSaved = await callTool(owner, "create_deal", { name: "CSI deal", nextStep: "Call" });
assert.deepEqual({ ...firstSaved.result, id: undefined }, { id: undefined, pipeline: "CSI pipeline", stage: "Target" }, "omitted pipeline = first saved pipeline by rowid, first open stage");
assert.deepEqual({ ...sqlite.prepare("SELECT pipeline_key,stage_key FROM deals WHERE id=?").get(firstSaved.result.id) }, { pipeline_key: "csi", stage_key: "target" });
const named = await callTool(owner, "create_deal", { name: "NB deal", nextStep: "Call", pipeline: "new BUSINESS", stage: "discovery" });
assert.deepEqual({ pipeline: named.result.pipeline, stage: named.result.stage }, { pipeline: "New business", stage: "Discovery" }, "pipeline by name, case-insensitive");
const byId = await callTool(owner, "create_deal", { name: "Aard deal", nextStep: "Call", pipeline: "AARD" });
assert.deepEqual({ pipeline: byId.result.pipeline, stage: byId.result.stage }, { pipeline: "Aardvark pipeline", stage: "Intro" }, "pipeline by id");
const badPipe = await callTool(owner, "create_deal", { name: "X", nextStep: "Call", pipeline: "Nope" });
assert.equal(badPipe.status, 400); assert.ok(/CSI pipeline/.test(badPipe.error) && /New business/.test(badPipe.error) && /Aardvark pipeline/.test(badPipe.error), badPipe.error);
const badStage = await callTool(owner, "create_deal", { name: "X", nextStep: "Call", pipeline: "csi", stage: "Qualified" });
assert.equal(badStage.status, 400); assert.equal(badStage.error, "Unknown stage. Stages: Target, Proposal, Won, Lost.");

// A4: update_contact to another contact's email is a 409, not a 500
const dupEmail = await callTool(editor, "update_contact", { id: created.result.id, email: "ADA@example.com" });
assert.deepEqual({ ok: dupEmail.ok, status: dupEmail.status, error: dupEmail.error }, { ok: false, status: 409, error: "A contact with that email already exists." });
assert.equal((await callTool(editor, "update_contact", { id: created.result.id, email: "Grace@Example.com" })).ok, true, "own email (any case) is fine");

// sanitize
assert.deepEqual(sanitize({ a: "b", share_token: "x", apiKeyHash: "y", nested: [{ password: "p", ok: 1 }] }), { a: "b", nested: [{ ok: 1 }] });
console.log("PASS: MCP tools — catalogue, reads, permissions, writes, audit attribution, sanitising");
