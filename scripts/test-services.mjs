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
