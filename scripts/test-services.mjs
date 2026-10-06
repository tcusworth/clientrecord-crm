import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
const db = env.DB;
const { ServiceError } = load("lib/services/errors.ts");
const contacts = load("lib/services/contacts.ts");
sqlite.exec(`INSERT INTO suppressions(email,reason,source,created_at) VALUES ('blocked@example.com','Unsubscribed','Public page','now');
INSERT INTO automation_sequences(id,name,trigger_type,trigger_value,active,created_at,updated_at) VALUES (1,'Customer onboarding','Contact stage','Customer',1,'now','now');
INSERT INTO automation_steps(sequence_id,step_order,delay_days,action_type,subject,body) VALUES (1,1,2,'Email','Hi','Welcome');`);

// create: required fields, suppression, company reconciliation, duplicate email
await assert.rejects(contacts.createContact(db, { firstName: "", lastName: "X", email: "a@example.com" }), e => e instanceof ServiceError && e.status === 400);
const { id: ada } = await contacts.createContact(db, { firstName: "Ada", lastName: "Lovelace", email: "ADA@example.com", company: "Analytical Engines", tags: ["vip"] });
const row = sqlite.prepare("SELECT email,subscribed,tags,stage,lead_source FROM contacts WHERE id=?").get(ada);
assert.deepEqual({ ...row }, { email: "ada@example.com", subscribed: 1, tags: '["vip"]', stage: "Lead", lead_source: "Direct" });
assert.ok(sqlite.prepare("SELECT id FROM companies WHERE name='Analytical Engines'").get(), "company reconciled");
const { id: blocked } = await contacts.createContact(db, { firstName: "B", lastName: "C", email: "blocked@example.com" });
assert.equal(sqlite.prepare("SELECT subscribed FROM contacts WHERE id=?").get(blocked).subscribed, 0, "suppressed emails stay unsubscribed");
await assert.rejects(contacts.createContact(db, { firstName: "Ada", lastName: "L", email: "ada@example.com" }), e => e.status === 409 && /already exists/.test(e.message));

// update: full replace + stage-trigger enrollment
await contacts.updateContact(db, ada, { firstName: "Ada", lastName: "King", email: "ada@example.com", company: "Analytical Engines", stage: "Customer", tags: [] });
assert.equal(sqlite.prepare("SELECT last_name FROM contacts WHERE id=?").get(ada).last_name, "King");
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM automation_enrollments WHERE contact_id=? AND status='Active'").get(ada).n, 1);
await contacts.updateContact(db, ada, { firstName: "Ada", lastName: "King", email: "ada@example.com", stage: "Customer" });
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM automation_enrollments WHERE contact_id=?").get(ada).n, 1, "no duplicate enrollment");
await assert.rejects(contacts.updateContact(db, 999999, { firstName: "X", lastName: "Y", email: "x@example.com" }), e => e.status === 404);

// activity + tasks
await contacts.logContactActivity(db, { contactId: ada, note: "Discussed pricing", nextFollowUp: "2026-10-05", owner: "Owner", now: "2026-09-27T10:00:00.000Z" });
assert.equal(sqlite.prepare("SELECT type,note FROM activities WHERE contact_id=?").get(ada).type, "Note");
assert.deepEqual({ ...sqlite.prepare("SELECT last_contact,next_follow_up FROM contacts WHERE id=?").get(ada) }, { last_contact: "2026-09-27", next_follow_up: "2026-10-05" });
await assert.rejects(contacts.logContactActivity(db, { contactId: 999999, note: "x", owner: "o" }), e => e.status === 404);
const { id: task } = await contacts.createContactTask(db, { contactId: ada, title: "Send deck", dueDate: "2026-10-01", owner: "Owner" });
assert.equal(await contacts.completeContactTask(db, task), true);
assert.equal(sqlite.prepare("SELECT completed,status FROM tasks WHERE id=?").get(task).status, "Completed");
assert.equal(await contacts.completeContactTask(db, 999999), false);
await assert.rejects(contacts.createContactTask(db, { contactId: ada, title: "x", dueDate: "not-a-date", owner: "o" }), e => e.status === 400);
console.log("PASS: contact services");

const companies = load("lib/services/companies.ts");
await assert.rejects(companies.saveCompany(db, { name: "Acme", owner: "not-an-email" }, "owner@example.com"), e => e.status === 400 && /email address/.test(e.message));
await assert.rejects(companies.saveCompany(db, { name: "Acme", owner: "o@example.com", website: "acme.com" }, "owner@example.com"), e => /https/.test(e.message));
await assert.rejects(companies.saveCompany(db, { name: "Acme", owner: "o@example.com", fit_score: 40 }, "owner@example.com"), e => /fit score/i.test(e.message));
const acme = await companies.saveCompany(db, { name: "Acme", owner: "O@Example.com", website: "https://www.acme.com/", domain: "https://www.acme.com/", tags: ["a", "b"] }, "owner@example.com", "2026-09-27T10:00:00.000Z");
assert.equal(acme.before, null);
const acmeRow = sqlite.prepare("SELECT owner,domain,tags,temperature FROM companies WHERE id=?").get(acme.id);
assert.deepEqual({ ...acmeRow }, { owner: "o@example.com", domain: "acme.com", tags: '["a","b"]', temperature: "Cold" });
const again = await companies.saveCompany(db, { name: "Acme", owner: "o@example.com", stage: "Customer" }, "owner@example.com");
assert.equal(again.id, acme.id); assert.equal(again.before.name, "Acme");
await companies.appendCompanyNote(db, acme.id, "Signed MSA", "Owner", "2026-09-27T10:00:00.000Z");
await companies.appendCompanyNote(db, acme.id, "Kickoff booked", "Owner", "2026-09-28T09:00:00.000Z");
assert.equal(sqlite.prepare("SELECT notes FROM companies WHERE id=?").get(acme.id).notes, "[2026-09-27 Owner] Signed MSA\n[2026-09-28 Owner] Kickoff booked");
await assert.rejects(companies.appendCompanyNote(db, 999999, "x", "o"), e => e.status === 404);
console.log("PASS: company services");

const deals = load("lib/services/deals.ts");
await assert.rejects(deals.saveDeal(db, { name: "Big", owner: "Owner", pipeline_key: "default", stage_key: "Nope" }, "owner@example.com"), e => /pipeline/.test(e.message));
await assert.rejects(deals.saveDeal(db, { name: "Big", owner: "Owner", pipeline_key: "default", stage_key: "Qualified" }, "owner@example.com"), e => /next action/.test(e.message));
const big = await deals.saveDeal(db, { name: "Big", owner: "Owner", pipeline_key: "default", stage_key: "Qualified", next_step: "Call", value: 1500, company_id: acme.id }, "owner@example.com", "2026-09-27T10:00:00.000Z");
assert.ok(big.id > 0); assert.equal(big.changed, true);
assert.deepEqual({ ...sqlite.prepare("SELECT value,stage,status,company FROM deals WHERE id=?").get(big.id) }, { value: 150000, stage: "Qualified", status: "Open", company: "Acme" });
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM deal_stage_history WHERE deal_id=?").get(big.id).n, 1);
const moved = await deals.saveDeal(db, { id: big.id, name: "Big", owner: "Owner", pipeline_key: "default", stage_key: "Won", closed_reason: "Great fit", value: 1500, company_id: acme.id }, "owner@example.com");
assert.equal(moved.id, big.id); assert.equal(moved.before.stage, "Qualified");
assert.equal(sqlite.prepare("SELECT status FROM deals WHERE id=?").get(big.id).status, "Won");
await assert.rejects(deals.saveDeal(db, { id: 999999, name: "X", owner: "O", pipeline_key: "default", stage_key: "Qualified", next_step: "x" }, "o"), e => e.status === 404);
const note = await deals.addDealNote(db, { dealId: big.id, body: "Champion is the CFO", owner: "owner@example.com" });
assert.ok(note.id > 0);
await assert.rejects(deals.addDealNote(db, { dealId: 999999, body: "x", owner: "o" }), e => e.status === 404);
const act = await deals.logDealActivity(db, { dealId: big.id, type: "Call", body: "Pricing call", followUpAt: "2026-10-02", owner: "owner@example.com" });
assert.ok(act.id > 0);
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM deal_tasks WHERE deal_id=?").get(big.id).n, 1, "follow-up task created");
const dt = await deals.createDealTask(db, { dealId: big.id, title: "Send contract", owner: "Owner", dueDate: "2026-10-03" });
assert.equal(await deals.setDealTaskCompleted(db, dt.id, true), true);
assert.equal(sqlite.prepare("SELECT completed FROM deal_tasks WHERE id=?").get(dt.id).completed, 1);
assert.equal(await deals.setDealTaskCompleted(db, 999999, true), false);
console.log("PASS: deal services");

const reads = load("lib/services/read-models.ts");
const open = await deals.saveDeal(db, { name: "Open One", owner: "Owner", pipeline_key: "default", stage_key: "Proposal", next_step: "Send", value: 1000, company_id: acme.id, close_date: "2026-10-10" }, "owner@example.com", "2026-09-27T10:00:00.000Z");
sqlite.prepare("UPDATE deals SET stage_entered_at=? WHERE id=?").run("2026-08-01T00:00:00.000Z", open.id);
const detail = await reads.dealDetail(db, big.id);
assert.equal(detail.deal.value, 1500); assert.equal(detail.notes.length, 1); assert.ok(detail.activities.length >= 1); assert.ok(Array.isArray(detail.stakeholders));
assert.equal(await reads.dealDetail(db, 999999), null);
const listed = await reads.listDeals(db, { status: "Open", limit: 100 });
assert.equal(listed.limit, 25, "limit capped at 25"); assert.ok(listed.rows.some(r => r.id === open.id)); assert.ok(!listed.rows.some(r => r.id === big.id), "won deal excluded from Open");
assert.equal((await reads.listDeals(db, { q: "open o" })).total, 1);
assert.equal((await reads.listDeals(db, { q: "%" })).total, 0, "LIKE wildcards are escaped");
assert.ok((await reads.listDeals(db, { stalledOnly: true })).rows.some(r => r.id === open.id));
const summary = await reads.pipelineSummary(db);
assert.equal(summary.byStage.find(r => r.stage === "Proposal").value, 1000);
assert.equal(summary.weightedForecast, 600, "1000 x 60%");
assert.ok(summary.stalled.some(r => r.id === open.id));
await contacts.createContactTask(db, { contactId: ada, title: "Mine contact past", dueDate: "2026-09-20", owner: "Owner" });
await contacts.createContactTask(db, { contactId: ada, title: "Other person", dueDate: "2026-09-20", owner: "someone.else@example.com" });
const soonDeal = await deals.createDealTask(db, { dealId: open.id, title: "Soon deal task", owner: "owner", dueDate: "2026-09-30" });
await deals.createDealTask(db, { dealId: open.id, title: "Far deal task", owner: "Owner", dueDate: "2026-11-30" });
const mine = await reads.listTasks(db, { scope: "mine", owners: ["Owner"], today: "2026-09-27" });
assert.ok(mine.rows.length >= 2 && mine.rows.some(r => r.kind === "deal") && mine.rows.some(r => r.kind === "contact"));
assert.ok(mine.rows.every(r => String(r.owner).toLowerCase() === "owner" && ["contact", "deal"].includes(r.kind)), "mine excludes other owners");
const all = await reads.listTasks(db, { scope: "all", owners: ["Owner"], today: "2026-09-27" });
assert.ok(all.rows.some(r => r.owner === "someone.else@example.com"), "all ignores owners");
const overdue = await reads.listTasks(db, { scope: "overdue", owners: ["Owner"], today: "2026-12-31" });
assert.ok(overdue.rows.length >= 2 && overdue.rows.every(r => r.dueDate < "2026-12-31" && !r.completed && String(r.owner).toLowerCase() === "owner"));
const soon = await reads.listTasks(db, { scope: "due_soon", owners: ["Owner"], today: "2026-09-27" });
assert.ok(soon.rows.some(r => r.id === soonDeal.id && r.kind === "deal") && soon.rows.every(r => r.dueDate >= "2026-09-27" && r.dueDate <= "2026-10-04"), "due_soon within 7 days");
const dealOnly = await reads.listTasks(db, { scope: "all", dealId: open.id, today: "2026-09-27" });
assert.ok(dealOnly.rows.length === 2 && dealOnly.rows.every(r => r.kind === "deal" && r.dealId === open.id));
for (const scope of ["mine", "overdue", "due_soon"]) { assert.deepEqual((await reads.listTasks(db, { scope, today: "2026-12-31" })).rows, [], scope + " without owners is empty"); assert.deepEqual((await reads.listTasks(db, { scope, owners: [], today: "2026-12-31" })).rows, []); }
console.log("PASS: read models");
