import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
const { parseUpsertInput } = load("lib/contact-upsert-input.ts");
const auth = load("lib/crm-auth.ts");

// Schema
sqlite.prepare("INSERT INTO contact_lists(name,created_at) VALUES ('State of OPA 2026',datetime('now'))").run();
assert.throws(() => sqlite.prepare("INSERT INTO contact_lists(name,created_at) VALUES ('state of opa 2026',datetime('now'))").run(), /UNIQUE/);
sqlite.prepare("INSERT INTO form_submissions(id,submission_id,action,source,created_at) VALUES ('a','s1','created','decoder','now')").run();
assert.throws(() => sqlite.prepare("INSERT INTO form_submissions(id,submission_id,action,source,created_at) VALUES ('b','s1','created','decoder','now')").run(), /UNIQUE/);
sqlite.prepare("INSERT INTO form_submissions(id,action,source,created_at) VALUES ('c','created','decoder','now'),('d','created','decoder','now')").run(); // many NULL submission ids allowed

// Validator
const ok = parseUpsertInput({ email: "  Jane.Doe@X.com ", fullName: "Jane van Doe", source: "report_download", reportName: "State of OPA 2026", consent: "on", lists: ["State of OPA 2026", " state of opa 2026 ", "Insights"], utm: { source: "linkedin" } });
assert.equal(ok.ok, true);
assert.equal(ok.value.email, "jane.doe@x.com");
assert.deepEqual([ok.value.firstName, ok.value.lastName], ["Jane", "van Doe"]);
assert.equal(ok.value.consent, true);
assert.deepEqual(ok.value.lists, ["State of OPA 2026", "Insights"]);
assert.equal(ok.value.utm.source, "linkedin");
assert.equal(ok.value.utm.medium, "");
assert.deepEqual(parseUpsertInput({ email: "a@b.co", firstName: "Al", fullName: "Zed Q", source: "decoder" }).value.lastName, "Q", "fullName only fills the missing part");
for (const [value, expected] of [["true", true], ["yes", true], ["1", true], [false, false], ["off", false], ["no", false], ["0", false], [undefined, null]]) assert.equal(parseUpsertInput({ email: "a@b.co", source: "decoder", consent: value }).value.consent, expected, String(value));
const bad = body => parseUpsertInput(body);
assert.deepEqual(Object.keys(bad({ source: "decoder" }).fields), ["email"]);
assert.ok(bad({ email: "nope", source: "decoder" }).fields.email);
assert.ok(bad({ email: "a@b.co", source: "webinar" }).fields.source);
for (const source of ["constructor", "toString", "__proto__"]) assert.ok(bad({ email: "a@b.co", source }).fields?.source, `source ${source} rejected`);
assert.ok(bad({ email: "a@b.co", source: "report_download" }).fields.reportName);
assert.ok(bad({ email: "a@b.co", source: "decoder", consent: "maybe" }).fields.consent);
assert.ok(bad({ email: "a@b.co", source: "decoder", lists: Array.from({ length: 11 }, (_, i) => `L${i}`) }).fields.lists);
assert.ok(bad({ email: "a@b.co", source: "decoder", lists: "State" }).fields.lists);
assert.ok(bad({ email: "a@b.co", source: "decoder", jobTitle: "x".repeat(201) }).fields.jobTitle);
assert.ok(bad({ email: "a@b.co", source: "decoder", note: { body: "x".repeat(10001) } }).fields["note.body"]);
for (const body of [null, [], "text", 42]) assert.equal(parseUpsertInput(body).ok, false);
console.log("contact upsert: schema + validator ok");

// Service
const { upsertContact } = load("lib/contact-upsert.ts");
// audit() emits a webhook through fetch; stub it so no network call is made.
globalThis.fetch = async () => new Response("ok");
const user = { id: "api:key1", email: "trevor@example.com", role: "editor", permissions: ["records.view", "records.edit"] };
const input = body => { const r = parseUpsertInput(body); assert.equal(r.ok, true, JSON.stringify(r.fields)); return r.value; };
const contact = email => sqlite.prepare("SELECT * FROM contacts WHERE lower(email)=lower(?)").get(email);
const count = (sql, ...a) => Object.values(sqlite.prepare(sql).get(...a))[0];

// create
let r = await upsertContact(input({ email: "Jane@Acme.com", firstName: "Jane", lastName: "Doe", jobTitle: "VP", company: "Acme", source: "report_download", reportName: "State of OPA 2026", consent: true, lists: ["State of OPA 2026"], note: { title: "Downloaded", body: "Report" }, utm: { source: "linkedin", campaign: "opa26" }, referrer: "https://google.com", submissionId: "sub-1" }), user);
assert.equal(r.action, "created"); assert.ok(r.contactId > 0);
let c = contact("jane@acme.com");
assert.equal(c.title, "VP"); assert.equal(c.subscribed, 1); assert.equal(c.first_source, "report_download"); assert.equal(c.latest_source, "report_download");
assert.equal(count("SELECT count(*) FROM activities WHERE contact_id=? AND type='Note'", r.contactId), 1);
assert.equal(count("SELECT note FROM activities WHERE contact_id=?", r.contactId), "Downloaded\n\nReport");
assert.equal(count("SELECT count(*) FROM tasks WHERE contact_id=?", r.contactId), 0, "downloads create no task");
assert.equal(r.lists[0].name, "State of OPA 2026");
let s = sqlite.prepare("SELECT * FROM form_submissions WHERE submission_id='sub-1'").get();
assert.equal(s.utm_campaign, "opa26"); assert.equal(s.report_name, "State of OPA 2026"); assert.equal(s.consent, 1); assert.equal(s.api_key_id, "key1");

// duplicate submissionId: no new writes
r = await upsertContact(input({ email: "jane@acme.com", source: "report_download", reportName: "State of OPA 2026", note: { title: "again" }, submissionId: "sub-1" }), user);
assert.equal(r.action, "duplicate"); assert.equal(r.lists[0].name, "State of OPA 2026", "duplicate replay returns lists");
assert.equal(count("SELECT count(*) FROM activities WHERE contact_id=?", r.contactId), 1);
assert.equal(count("SELECT count(*) FROM form_submissions WHERE contact_id=?", r.contactId), 1);

// update
r = await upsertContact(input({ email: "  JANE@acme.COM ", firstName: "", jobTitle: "", company: "Acme Corp", source: "contact_form", consent: false, lists: [" state of opa 2026 ", "Contact requests"] }), user);
assert.equal(r.action, "updated");
c = contact("jane@acme.com");
assert.equal(c.first_name, "Jane"); assert.equal(c.title, "VP"); assert.equal(c.company, "Acme Corp");
assert.equal(c.first_source, "report_download"); assert.equal(c.latest_source, "contact_form");
assert.equal(c.subscribed, 1, "consent false never unsubscribes");
assert.equal(count("SELECT count(*) FROM tasks WHERE contact_id=? AND title LIKE 'Respond to Jane · Contact form'", r.contactId), 1);
assert.equal(count("SELECT count(*) FROM contact_lists"), 2, "State of OPA 2026 (seeded in the Task 1 schema test, reused, never duplicated) + Contact requests");
assert.equal(count("SELECT count(*) FROM contact_list_members WHERE contact_id=?", r.contactId), 2);
const tk = sqlite.prepare("SELECT owner,due_date FROM tasks WHERE contact_id=?").get(r.contactId);
assert.equal(tk.owner, user.email); assert.equal(tk.due_date, new Date().toISOString().slice(0, 10));
assert.equal(sqlite.prepare("SELECT task_id FROM form_submissions WHERE contact_id=? AND source='contact_form'").get(r.contactId).task_id > 0, true);

// consent rules on existing contacts
sqlite.prepare("INSERT INTO contacts(first_name,last_name,email,subscribed,suppression_reason,created_at) VALUES ('Sup','Pressed','sup@x.com',0,'bounced',datetime('now'))").run();
await upsertContact(input({ email: "sup@x.com", source: "decoder", consent: true }), user);
assert.equal(contact("sup@x.com").subscribed, 0, "suppressed stays unsubscribed");
sqlite.prepare("INSERT INTO contacts(first_name,last_name,email,subscribed,created_at) VALUES ('Never','Sub','never@x.com',0,datetime('now'))").run();
await upsertContact(input({ email: "never@x.com", source: "insights_signup", consent: "yes" }), user);
assert.equal(contact("never@x.com").subscribed, 1, "consent true subscribes a never-subscribed contact");
r = await upsertContact(input({ email: "new@x.com", source: "epc_inquiry" }), user);
assert.equal(contact("new@x.com").subscribed, 0, "new contact without consent is unsubscribed");
assert.equal(count("SELECT count(*) FROM tasks WHERE contact_id=?", r.contactId), 1, "epc_inquiry creates a task");

// non-ASCII list names
r = await upsertContact(input({ email: "uni@x.com", source: "decoder", lists: ["Événements"], submissionId: "sub-uni" }), user);
assert.deepEqual(r.lists.map(l => l.name), ["Événements"]);
r = await upsertContact(input({ email: "uni@x.com", source: "decoder", submissionId: "sub-uni" }), user);
assert.deepEqual(r.lists.map(l => l.name), ["Événements"], "duplicate replay");

// atomicity
sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON form_submissions BEGIN SELECT RAISE(ABORT,'boom'); END;");
await assert.rejects(() => upsertContact(input({ email: "atomic@x.com", source: "decoder", lists: ["Atomic"] }), user));
assert.equal(contact("atomic@x.com"), undefined); assert.equal(count("SELECT count(*) FROM contact_lists WHERE name='Atomic'"), 0);
sqlite.exec("DROP TRIGGER boom");
console.log("contact upsert: service ok");

// HTTP route
const route = load("app/api/v1/contacts/upsert/route.ts");
async function key(scopes) { const raw = `cr_live_${crypto.randomUUID()}`; sqlite.prepare("INSERT INTO api_keys(id,name,key_hash,key_prefix,scopes,created_by,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run(crypto.randomUUID(), "t", await auth.sha256(raw), raw.slice(0, 12), scopes, "trevor@example.com"); return raw; }
const leads = await key("leads.capture"), readOnly = await key("records.read");
const call = async (body, token = leads, rawBody) => { const res = await route.POST(new Request("https://crm.example.com/api/v1/contacts/upsert", { method: "POST", headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json" }, body: rawBody ?? JSON.stringify(body) })); return { status: res.status, body: await res.json() }; };
assert.equal((await call({ email: "r@x.com", source: "decoder" }, "")).status, 401);
assert.equal((await call({ email: "r@x.com", source: "decoder" }, "cr_live_nope")).status, 401);
assert.equal((await call({ email: "r@x.com", source: "decoder" }, readOnly)).status, 403);
assert.equal((await call(null, leads, "{bad json")).status, 400);
for (const b of [[], null, "text", 42]) assert.equal((await call(b)).status, 400, JSON.stringify(b));
let res = await call({ email: "r@x.com", source: "report_download" });
assert.equal(res.status, 400); assert.ok(res.body.fields.reportName);
assert.equal((await call(null, leads, JSON.stringify({ email: "r@x.com", source: "decoder", note: { body: "x".repeat(21000) } }))).status, 413);
res = await call({ email: "r@x.com", source: "decoder", submissionId: "http-1" });
assert.equal(res.status, 201); assert.equal(res.body.action, "created");
res = await call({ email: "r@x.com", source: "decoder", submissionId: "http-1" });
assert.equal(res.status, 200); assert.equal(res.body.action, "duplicate");
res = await call({ email: "r@x.com", source: "decoder" });
assert.equal(res.status, 200); assert.equal(res.body.action, "updated");
// concurrent same submissionId
const [a, b2] = await Promise.all([call({ email: "race@x.com", source: "decoder", submissionId: "race-1" }), call({ email: "race@x.com", source: "decoder", submissionId: "race-1" })]);
assert.deepEqual([a.status, b2.status].sort(), [200, 201]);
assert.equal(count("SELECT count(*) FROM form_submissions WHERE submission_id='race-1'"), 1);
// 5xx mapping
sqlite.exec("CREATE TRIGGER boom2 BEFORE INSERT ON form_submissions BEGIN SELECT RAISE(ABORT,'D1_ERROR: storage overloaded'); END;");
res = await call({ email: "x5@x.com", source: "decoder" }); assert.equal(res.status, 503); assert.deepEqual(res.body, { error: "Temporary failure; retry." });
sqlite.exec("DROP TRIGGER boom2; CREATE TRIGGER boom3 BEFORE INSERT ON form_submissions BEGIN SELECT RAISE(ABORT,'something else'); END;");
res = await call({ email: "x5@x.com", source: "decoder" }); assert.equal(res.status, 500);
sqlite.exec("DROP TRIGGER boom3");
// session identity must not authenticate
assert.equal((await route.POST(new Request("https://crm.example.com/api/v1/contacts/upsert", { method: "POST", headers: { "oai-authenticated-user-id": "u", "oai-authenticated-user-email": "trevor@example.com" }, body: JSON.stringify({ email: "s@x.com", source: "decoder" }) }))).status, 401);
// openapi documents it
const spec = await (await load("app/api/openapi/route.ts").GET(new Request("https://crm.example.com/api/openapi"))).json();
assert.ok(spec.paths["/api/v1/contacts/upsert"]?.post?.responses?.["503"]);
// ruling 1: unique-race retry, driven deterministically by wrapping env.DB.batch
async function withBatch(wrap, fn) { const orig = env.DB.batch, real = orig.bind(env.DB); let calls = 0; env.DB.batch = (stmts) => wrap(++calls, () => real(stmts)); try { return await fn(() => calls); } finally { env.DB.batch = orig; } }
const addContact = email => Number(sqlite.prepare("INSERT INTO contacts(first_name,last_name,email,company,title,stage,tags,subscribed,created_at,updated_at) VALUES ('','',?,'','','Lead','[]',0,datetime('now'),datetime('now'))").run(email).lastInsertRowid);
await withBatch((n, real) => { if (n === 1) { addContact("racea@x.com"); throw new Error("UNIQUE constraint failed: contacts.email"); } return real(); }, async calls => {
  res = await call({ email: "racea@x.com", source: "decoder" });
  assert.equal(res.status, 200); assert.equal(res.body.action, "updated"); assert.equal(calls(), 2);
});
await withBatch((n, real) => { if (n === 1) { const id = addContact("raceb@x.com"); sqlite.prepare("INSERT INTO form_submissions(id,submission_id,contact_id,action,source,created_at) VALUES ('race-b-row','race-b',?,'created','decoder',datetime('now'))").run(id); throw new Error("UNIQUE constraint failed: form_submissions.submission_id"); } return real(); }, async calls => {
  res = await call({ email: "raceb@x.com", source: "decoder", submissionId: "race-b" });
  assert.equal(res.status, 200); assert.equal(res.body.action, "duplicate"); assert.equal(calls(), 1); // retry short-circuits at the duplicate lookup
});
await withBatch(() => { throw new Error("UNIQUE constraint failed: contacts.email"); }, async calls => {
  res = await call({ email: "racec@x.com", source: "decoder" });
  assert.equal(res.status, 500); assert.equal(calls(), 2);
});
console.log("contact upsert: http ok");
