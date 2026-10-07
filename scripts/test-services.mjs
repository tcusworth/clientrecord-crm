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
// opt-in (AI path): no re-enrollment when the stage is unchanged, even after the earlier enrollment completed
sqlite.prepare("UPDATE automation_enrollments SET status='Completed' WHERE contact_id=?").run(ada);
await contacts.updateContact(db, ada, { firstName: "Ada", lastName: "King", email: "ada@example.com", stage: "Customer" }, [], { enrollOnlyOnStageChange: true });
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM automation_enrollments WHERE contact_id=?").get(ada).n, 1, "unchanged stage with the flag does not re-enroll");
await contacts.updateContact(db, ada, { firstName: "Ada", lastName: "King", email: "ada@example.com", stage: "Lead" }, [], { enrollOnlyOnStageChange: true });
await contacts.updateContact(db, ada, { firstName: "Ada", lastName: "King", email: "ada@example.com", stage: "Customer" }, [], { enrollOnlyOnStageChange: true });
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM automation_enrollments WHERE contact_id=? AND status='Active'").get(ada).n, 1, "a real stage change with the flag still enrolls");
await assert.rejects(contacts.updateContact(db, 999999, { firstName: "X", lastName: "Y", email: "x@example.com" }), e => e.status === 404);

// activity + tasks
await contacts.logContactActivity(db, { contactId: ada, note: "Discussed pricing", nextFollowUp: "2026-10-05", owner: "Owner", now: "2026-09-27T10:00:00.000Z" });
assert.equal(sqlite.prepare("SELECT type,note FROM activities WHERE contact_id=?").get(ada).type, "Note");
assert.deepEqual({ ...sqlite.prepare("SELECT last_contact,next_follow_up FROM contacts WHERE id=?").get(ada) }, { last_contact: "2026-09-27", next_follow_up: "2026-10-05" });
await assert.rejects(contacts.logContactActivity(db, { contactId: 999999, note: "x", owner: "o" }), e => e.status === 404);
// opt-in (AI path): an older activity never moves last_contact backwards; without the flag (CRM) it is set as before
await contacts.logContactActivity(db, { contactId: ada, note: "Old call", owner: "Owner", now: "2026-01-02T10:00:00.000Z" }, { keepLatestContact: true });
assert.equal(sqlite.prepare("SELECT last_contact FROM contacts WHERE id=?").get(ada).last_contact, "2026-09-27", "flag keeps the newer date");
await contacts.logContactActivity(db, { contactId: ada, note: "Later call", owner: "Owner", now: "2026-09-29T10:00:00.000Z" }, { keepLatestContact: true });
assert.equal(sqlite.prepare("SELECT last_contact FROM contacts WHERE id=?").get(ada).last_contact, "2026-09-29", "flag still advances");
await contacts.logContactActivity(db, { contactId: ada, note: "CRM back-dated", owner: "Owner", now: "2026-09-27T10:00:00.000Z" });
assert.equal(sqlite.prepare("SELECT last_contact FROM contacts WHERE id=?").get(ada).last_contact, "2026-09-27", "CRM path unchanged");
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
assert.deepEqual(summary.byPipeline.map(p => p.pipeline), [{ id: "default", name: "New business" }]);
assert.deepEqual(summary.byPipeline[0].stages, [{ stage: "Proposal", count: 1, value: 1000 }]);
assert.deepEqual({ open: summary.byPipeline[0].openValue, weighted: summary.byPipeline[0].weightedForecast }, { open: 1000, weighted: 600 });
assert.equal(summary.openValue, 1000);
assert.equal(summary.weightedForecast, 600, "1000 x 60%");
assert.ok(summary.stalled.some(r => r.id === open.id));
// closingWithinDays: today..today+N only, never past close dates
const isoDay = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const closing = {};
for (const [label, offset] of [["past", -3], ["today", 0], ["soon", 5], ["far", 40]]) closing[label] = (await deals.saveDeal(db, { name: `Closing ${label}`, owner: "Owner", pipeline_key: "default", stage_key: "Discovery", next_step: "x", close_date: isoDay(offset) }, "owner@example.com")).id;
const closingIds = (await reads.listDeals(db, { q: "Closing", closingWithinDays: 30 })).rows.map(r => r.id).sort();
assert.deepEqual(closingIds, [closing.today, closing.soon].sort(), "past-dated and too-far deals excluded");
for (const id of Object.values(closing)) { sqlite.prepare("DELETE FROM deal_stage_history WHERE deal_id=?").run(id); sqlite.prepare("DELETE FROM deals WHERE id=?").run(id); }
// pipeline summary keeps same-named stages in different pipelines apart, in each pipeline's own stage order
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES ('csi','CSI pipeline',?,'now')").run(JSON.stringify([{ key: "target", name: "Target", probability: 10, kind: "Open" }, { key: "proposal", name: "Proposal", probability: 50, kind: "Open" }, { key: "won", name: "Won", probability: 100, kind: "Won" }, { key: "lost", name: "Lost", probability: 0, kind: "Lost" }]));
await deals.saveDeal(db, { name: "CSI proposal", owner: "Owner", pipeline_key: "csi", stage_key: "proposal", next_step: "x", value: 2000 }, "owner@example.com");
await deals.saveDeal(db, { name: "CSI target", owner: "Owner", pipeline_key: "csi", stage_key: "target", next_step: "x", value: 500 }, "owner@example.com");
sqlite.exec("INSERT INTO deals(name,stage,stage_key,pipeline_key,owner,value,probability,status,created_at,updated_at) VALUES ('Legacy','Legacy','legacy','csi','Owner',300,0,'Open','now','now'),('Orphan','Old stage','old','gone','Owner',700,0,'Open','now','now')");
const multi = await reads.pipelineSummary(db);
assert.deepEqual(multi.byPipeline.map(p => ({ ...p.pipeline, openValue: p.openValue, weightedForecast: p.weightedForecast, stages: p.stages })), [
  { id: "default", name: "New business", openValue: 1000, weightedForecast: 600, stages: [{ stage: "Proposal", count: 1, value: 1000 }] },
  { id: "csi", name: "CSI pipeline", openValue: 2503, weightedForecast: 1050, stages: [{ stage: "Target", count: 1, value: 500 }, { stage: "Proposal", count: 1, value: 2000 }, { stage: "Legacy", count: 1, value: 3 }] },
  { id: "gone", name: "gone", openValue: 7, weightedForecast: 0, stages: [{ stage: "Old stage", count: 1, value: 7 }] },
], "Proposal in two pipelines is not merged");
assert.deepEqual({ open: multi.openValue, weighted: multi.weightedForecast }, { open: 3510, weighted: 1650 });
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
// custom field service: resolve by name or field_key (case-insensitive), validate like the CRM, read back keyed by field name
const fields = load("lib/services/custom-fields.ts");
sqlite.exec("INSERT INTO custom_field_definitions(entity_type,name,field_key,field_type,options,created_at) VALUES ('deal','Seats','seats','number','[]','now'),('deal','Renewal','renewal','date','[]','now'),('deal','Strategic','strategic','boolean','[]','now'),('contact','Tier','tier','text','[]','now')");
const resolved = await fields.resolveCustomFields(db, "deal", { SEATS: 12, renewal: "2027-01-31", Strategic: true, "deal type": "copa demo" });
const byName = Object.fromEntries(resolved.map(f => [f.name, f.value]));
assert.deepEqual(byName, { Seats: "12", Renewal: "2027-01-31", Strategic: "true", "Deal type": "COPA Demo" });
assert.deepEqual(await fields.resolveCustomFields(db, "deal", undefined), []);
for (const [input, message] of [[{ Seats: "lots" }, /valid number/], [{ Renewal: "soon" }, /valid date/], [{ Strategic: "maybe" }, /Yes or No/], [{ Seats: "x".repeat(4001) }, /4,000/], [{ Tier: "Gold" }, /Unknown deal field "Tier"/], [null, /object/]]) await assert.rejects(fields.resolveCustomFields(db, "deal", input), e => e instanceof ServiceError && e.status === 400 && message.test(e.message), JSON.stringify(input));
await db.batch(fields.customFieldStatements(db, "deal", open.id, resolved, "now"));
assert.deepEqual((await fields.customFieldsByRecord(db, "deal", [open.id, big.id])).get(open.id), { "Deal type": "COPA Demo", Renewal: "2027-01-31", Seats: "12", Strategic: "true" });
assert.deepEqual((await reads.listDeals(db, { q: "Open One" })).rows[0].fields, { "Deal type": "COPA Demo", Renewal: "2027-01-31", Seats: "12", Strategic: "true" });
assert.deepEqual((await reads.dealDetail(db, big.id)).deal.fields, {});
await db.batch(fields.customFieldStatements(db, "deal", open.id, [{ ...resolved[0], value: "" }], "now"));
assert.ok(!("Seats" in (await reads.dealDetail(db, open.id)).deal.fields), "blank clears");
console.log("PASS: read models");
