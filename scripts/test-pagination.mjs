// Server-side contact/company paging, search, filters, summaries and pickers (GET /api/crm?resource=...), the
// read-only guarantee for GET /api/crm and GET /api/sales, and company reconciliation on contact writes.
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const owner = "owner@example.com", viewer = "viewer@example.com";
const headers = email => email ? { "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" } : {};
const crmRoute = load("app/api/crm/route.ts"), salesRoute = load("app/api/sales/route.ts"), opsRoute = load("app/api/operations/route.ts");
const { likeContains, MAX_PAGE_SIZE } = load("lib/crm-records.ts");
let checks = 0;
async function get(route, path, email = owner, status = 200) { const response = await route.GET(new Request(`https://crm.example.com${path}`, { headers: headers(email) })), body = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(body).slice(0, 300)}`); checks++; return body; }
async function post(body, email = owner, status = 200) { const response = await crmRoute.POST(new Request("https://crm.example.com/api/crm", { method: "POST", headers: headers(email), body: JSON.stringify(body) })), result = await response.json(); assert.equal(response.status, status, `${body.action}: ${JSON.stringify(result)}`); checks++; return result; }
const crm = (query, email, status) => get(crmRoute, `/api/crm${query}`, email, status);
const one = (sql, ...args) => sqlite.prepare(sql).get(...args);
const totalChanges = () => one("SELECT total_changes() AS n").n;

// --- Seed: 130 contacts with a spread of stages, tags, subscription, activity dates and companies. ---
const today = new Date().toISOString().slice(0, 10), longAgo = "2020-01-01";
const stages = ["Lead", "Prospect", "Opportunity", "Customer"];
const insert = sqlite.prepare("INSERT INTO contacts(id,first_name,last_name,email,company,title,location,stage,tags,subscribed,last_contact,next_follow_up,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'now','now')");
for (let i = 1; i <= 130; i++) insert.run(i, `First${String(i).padStart(3, "0")}`, `Last${String(131 - i).padStart(3, "0")}`, `person${i}@example${i % 5}.test`, i % 10 === 0 ? "" : `Company ${i % 7}`, i % 3 ? "Engineer" : "Director", i % 2 ? "Denver" : "Boulder", stages[i % 4], JSON.stringify(i % 6 === 0 ? ["VIP", "Priority"] : i % 11 === 0 ? ["newsletter"] : []), i % 9 === 0 ? 0 : 1, i % 4 === 0 ? longAgo : i % 4 === 1 ? today : null, i % 5 === 0 ? "2030-01-01" : null);
// Rows whose names contain LIKE wildcards, an injection-looking value, a duplicate pair and malformed tags JSON.
sqlite.exec(`INSERT INTO contacts(id,first_name,last_name,email,company,stage,tags,subscribed,created_at,updated_at) VALUES
 (201,'Percent','Hundred%','pct@example.test','Wild%Card','Lead','[]',1,'now','now'),
 (202,'Under','Score_Name','underscore@example.test','Under_Co','Lead','[]',1,'now','now'),
 (203,'Robert','Tables','bobby@example.test','x'' OR 1=1 --','Lead','not json',1,'now','now'),
 (204,'Robert','tables','bobby2@example.test','','Lead','["vip"]',1,'now','now')`);
for (let i = 0; i < 7; i++) sqlite.prepare("INSERT INTO companies(name,temperature,updated_at) VALUES (?,?, 'now')").run(`Company ${i}`, ["Cold", "Hot", "Lukewarm"][i % 3]);
sqlite.exec(`INSERT INTO companies(name,updated_at) VALUES ('Wild%Card','now'),('Under_Co','now'),('x'' OR 1=1 --','now');
 INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('${viewer}','Vera','viewer','{}','now','now');
 INSERT INTO job_runs(job_type,status,processed,failed,message,started_at,completed_at) VALUES ('daily-maintenance','Completed',0,0,'','${new Date().toISOString()}','${new Date().toISOString()}');
 INSERT INTO account_stakeholders(company_id,contact_id,role,notes) SELECT id,201,'Champion','' FROM companies WHERE name='Company 1';
 INSERT INTO activities(contact_id,type,note,happened_at) VALUES (203,'Call','Spoke about tables','2026-01-01T10:00:00Z'),(1,'Email','Other contact','2026-01-02T10:00:00Z');
 INSERT INTO segments(id,name,stage,tag,company,location,subscription,inactivity_days,created_at,updated_at) VALUES (1,'VIP customers','Customer','vip','','','Subscribed',0,'now','now'),(2,'Quiet Denver','Any','','','denver','Subscribed',365,'now','now');`);
const contactCount = one("SELECT count(*) AS n FROM contacts").n;

// --- Paging and totals ---
const pages = [];
for (let offset = 0; offset < contactCount; offset += 50) pages.push(await crm(`?resource=contacts&offset=${offset}&limit=50`));
assert.deepEqual(pages.map(page => page.rows.length), [50, 50, contactCount - 100]);
assert.ok(pages.every(page => page.total === contactCount));
const ids = pages.flatMap(page => page.rows.map(row => row.id));
assert.equal(new Set(ids).size, contactCount, "pages do not overlap and cover every contact");
const names = pages.flatMap(page => page.rows.map(row => `${row.lastName} ${row.firstName}`.toLowerCase()));
assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en")), "default sort is last name, first name (case-insensitive)");
assert.ok(pages[0].rows.every(row => Array.isArray(row.tags) && typeof row.subscribed === "boolean" && !("notes" in row)), "list rows parse tags, omit notes");
assert.deepEqual((await crm(`?resource=contacts&offset=${contactCount + 10}`)).rows, []);
// Limit caps and bad numbers.
assert.equal((await crm("?resource=contacts&limit=100000")).limit, MAX_PAGE_SIZE);
assert.equal((await crm("?resource=contacts&limit=100000")).rows.length, Math.min(MAX_PAGE_SIZE, contactCount));
assert.equal((await crm("?resource=contacts&limit=-4")).limit, 1);
assert.equal((await crm("?resource=contacts&limit=abc")).limit, 50);
assert.equal((await crm("?resource=contacts&offset=-20")).offset, 0);

// --- Filters (compared with the same rules applied in JS to the seeded rows) ---
const all = sqlite.prepare("SELECT * FROM contacts").all().map(row => ({ ...row, tags: (() => { try { return JSON.parse(row.tags); } catch { return []; } })() }));
const expectCount = async (query, predicate, label) => { const body = await crm(`?resource=contacts&limit=200&${query}`); assert.equal(body.total, all.filter(predicate).length, label); assert.equal(body.rows.length, Math.min(200, body.total)); return body; };
await expectCount("stage=Customer", row => row.stage === "Customer", "stage");
await expectCount("stage=Any", () => true, "stage Any");
await expectCount("subscription=Subscribed", row => row.subscribed === 1, "subscribed");
await expectCount("subscription=Unsubscribed", row => row.subscribed === 0, "unsubscribed");
await expectCount("tag=vi", row => row.tags.some(tag => tag.toLowerCase().includes("vi")), "tag contains, case-insensitive, malformed JSON ignored");
await expectCount("view=Customers", row => row.stage === "Customer", "customers view");
await expectCount("view=Needs%20follow-up", row => Boolean(row.next_follow_up), "follow-up view");
const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
await expectCount("view=Quiet%2030%2B%20days", row => Boolean(row.last_contact) && row.last_contact < cutoff, "quiet view");
await expectCount("q=denver", row => row.location === "Denver", "search location");
await expectCount("q=FIRST01", row => `${row.first_name} ${row.last_name}`.toLowerCase().includes("first01"), "search name, case-insensitive");
await expectCount("q=first005%20last126", row => `${row.first_name} ${row.last_name}`.toLowerCase().includes("first005 last126"), "search full name");
await expectCount("q=example3.test", row => row.email.includes("example3.test"), "search email");
await expectCount("stage=Lead&subscription=Subscribed&q=company%203", row => row.stage === "Lead" && row.subscribed === 1 && row.company.toLowerCase().includes("company 3"), "combined filters");
// LIKE wildcards are literal.
assert.equal(likeContains("50%_\\"), "%50\\%\\_\\\\%");
assert.deepEqual((await crm("?resource=contacts&q=%25")).rows.map(row => row.id), [201], "% only matches a literal percent");
assert.deepEqual((await crm("?resource=contacts&q=_")).rows.map(row => row.id), [202], "_ only matches a literal underscore");
// Injection attempts are just data.
assert.deepEqual((await crm(`?resource=contacts&q=${encodeURIComponent("' OR 1=1 --")}`)).rows.map(row => row.id), [203], "quote text matches only the row that contains it");
assert.equal((await crm(`?resource=contacts&stage=${encodeURIComponent("Customer' OR '1'='1")}`)).total, 0);
assert.equal((await crm(`?resource=contacts&tag=${encodeURIComponent("x') OR 1=1 --")}`)).total, 0);
const injectedSort = await crm(`?resource=contacts&sort=${encodeURIComponent("name; DROP TABLE contacts")}&limit=5`);
assert.equal(injectedSort.sort, "name", "unknown sort keys fall back to the allowlist default");
assert.equal(one("SELECT count(*) AS n FROM contacts").n, contactCount, "contacts table intact");
// Sort allowlist.
const recent = (await crm("?resource=contacts&sort=recent&limit=200")).rows.map(row => row.lastContact);
const recentValues = recent.filter(Boolean);
assert.deepEqual(recentValues, [...recentValues].sort().reverse(), "recent sorts newest contact first");
assert.equal(recent.findIndex(value => !value), recentValues.length, "contacts never contacted sort last");
const followup = (await crm("?resource=contacts&sort=followup&limit=200")).rows.map(row => row.nextFollowUp);
assert.ok(followup.slice(0, all.filter(row => row.next_follow_up).length).every(Boolean), "next follow-up first, empty last");

// --- Summary (COUNT aggregates) and segment counts ---
const boot = await crm("");
assert.equal(boot.contacts, undefined, "bootstrap no longer ships contacts");
assert.equal(boot.companies, undefined, "bootstrap no longer ships companies");
assert.deepEqual(boot.summary, {
  total: all.length, customers: all.filter(row => row.stage === "Customer").length, subscribed: all.filter(row => row.subscribed).length,
  subscribedCustomers: all.filter(row => row.subscribed && row.stage === "Customer").length, subscribedProspects: all.filter(row => row.subscribed && ["Prospect", "Opportunity"].includes(row.stage)).length,
  quiet: all.filter(row => row.last_contact && row.last_contact < cutoff).length, needsFollowUp: all.filter(row => row.next_follow_up).length,
});
assert.equal(boot.segments.find(segment => segment.id === 1).recipientCount, all.filter(row => row.subscribed && row.stage === "Customer" && row.tags.some(tag => tag.toLowerCase() === "vip")).length);
assert.equal(boot.segments.find(segment => segment.id === 2).recipientCount, all.filter(row => row.subscribed && row.location.toLowerCase().includes("denver") && (!row.last_contact || row.last_contact <= new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))).length);
assert.ok(boot.campaigns.every(campaign => !("html" in campaign)), "campaign bodies load on demand");

// --- Contact detail ---
const detail = await crm("?resource=contact&id=203");
assert.equal(detail.contact.id, 203);
assert.deepEqual(detail.contact.tags, [], "malformed tags JSON reads as empty");
assert.deepEqual(detail.activities.map(activity => activity.note), ["Spoke about tables"], "only this contact's activity");
assert.deepEqual(detail.duplicates.map(duplicate => duplicate.id), [204], "same name (case-insensitive) with an empty company is a likely duplicate");
await crm("?resource=contact&id=99999", owner, 404);
await crm("?resource=contact&id=abc", owner, 400);
await crm("?resource=nope", owner, 400);

// --- Companies ---
const companiesPage = await crm("?resource=companies&limit=4");
assert.equal(companiesPage.rows.length, 4);
assert.equal(companiesPage.total, one("SELECT count(*) AS n FROM companies").n);
assert.deepEqual(companiesPage.rows.map(row => row.name), sqlite.prepare("SELECT name FROM companies ORDER BY name LIMIT 4").all().map(row => row.name));
const hot = await crm("?resource=companies&temperature=Hot&limit=200");
assert.ok(hot.rows.length > 0 && hot.rows.every(row => row.temperature === "Hot"));
assert.equal(hot.temperatures.Hot, hot.total);
assert.equal((await crm("?resource=companies&temperature=Bogus")).total, companiesPage.total, "unknown temperature is ignored");
const company1 = (await crm("?resource=companies&q=company%201")).rows[0];
assert.equal(company1.people_count, all.filter(row => row.company.toLowerCase() === "company 1").length + 1, "people = contacts by company name + stakeholder links");
assert.deepEqual((await crm("?resource=companies&q=%25")).rows.map(row => row.name), ["Wild%Card"]);
const companyDetail = await crm(`?resource=company&id=${company1.id}`);
assert.equal(companyDetail.company.name, "Company 1");
assert.ok(companyDetail.people.some(person => person.id === 201), "stakeholder-linked contact included");
assert.equal((await crm("?resource=company&name=Company%202")).company.name, "Company 2");

// --- Search (pickers / command bar) ---
const found = await crm("?resource=search&q=first0&limit=100");
assert.ok(found.contacts.length === 20 && found.companies.length === 0 && found.deals.length === 0, "search results are capped at 20");
assert.deepEqual((await crm("?resource=search&types=contact&ids=5,7")).contacts.map(row => row.id).sort(), [5, 7]);
const scoped = (await crm(`?resource=search&types=contact&companyId=${company1.id}&limit=20`)).contacts;
assert.ok(scoped.length === Math.min(20, company1.people_count) && scoped.every(row => row.company === "Company 1" || row.id === 201), "picker scoped to one company");
assert.ok((await crm(`?resource=search&types=contact&companyId=${company1.id}&q=percent`)).contacts.some(row => row.id === 201), "stakeholder-linked contact is in the company scope");
assert.deepEqual((await crm("?resource=search&types=company&q=under_")).companies.map(row => row.name), ["Under_Co"]);
const mention = await crm(`?resource=mentions&text=${encodeURIComponent("call first007 last124 about company 3 renewal")}`);
assert.equal(mention.contact.id, 7);
assert.equal(mention.company.name, "Company 3");

// --- Permissions: viewers read; writes need edit; anonymous is rejected ---
await crm("?resource=contacts", viewer);
await crm("?resource=companies", viewer);
await crm("?resource=search&q=a", viewer);
await crm("?resource=contacts", null, 401);
await post({ action: "bulkUpdateContacts", ids: [1], stage: "Customer" }, viewer, 403);
await post({ action: "existingEmails", emails: ["person1@example1.test"] }, viewer, 403);

// --- GETs perform no writes (total_changes unchanged) ---
const beforeReads = totalChanges();
await crm("");
for (const query of ["?resource=contacts&q=a&tag=vip&view=Customers&sort=recent", "?resource=contact&id=1", "?resource=companies&temperature=Hot", "?resource=company&id=1", "?resource=search&q=co", "?resource=mentions&text=first001", "?resource=summary"]) await crm(query);
const sales = await get(salesRoute, "/api/sales");
assert.equal(sales.companies, undefined, "sales no longer ships every company");
assert.equal(sales.contacts, undefined, "sales no longer ships every contact");
await get(opsRoute, "/api/operations?view=today");
assert.equal(totalChanges(), beforeReads, "GET /api/crm, GET /api/sales and the Today queue do not write");
// Contact names that have no company row stay that way on reads (no reconciliation INSERT on GET).
sqlite.exec("INSERT INTO contacts(first_name,last_name,email,company,created_at,updated_at) VALUES ('Orphan','Name','orphan@example.test','Orphan Holdings','now','now')");
const afterOrphan = totalChanges();
await get(salesRoute, "/api/sales");
await crm("");
assert.equal(totalChanges(), afterOrphan);
assert.equal(one("SELECT count(*) AS n FROM companies WHERE name='Orphan Holdings'").n, 0);

// --- Company reconciliation happens on contact writes, idempotently and case-insensitively ---
const companyCount = name => one("SELECT count(*) AS n FROM companies WHERE lower(name)=lower(?)", name).n;
const created = await post({ action: "createContact", firstName: "New", lastName: "Person", email: "new.person@newco.test", company: "  NewCo  " }, owner, 201);
assert.equal(companyCount("newco"), 1);
assert.equal(one("SELECT name FROM companies WHERE lower(name)='newco'").name, "NewCo", "trimmed name");
await post({ action: "createContact", firstName: "Other", lastName: "Person", email: "other@newco.test", company: "newco" }, owner, 201);
assert.equal(companyCount("newco"), 1, "case-insensitive match is not duplicated");
await post({ action: "updateContact", id: created.id, firstName: "New", lastName: "Person", email: "new.person@newco.test", company: "Renamed Inc", stage: "Lead" });
assert.equal(companyCount("Renamed Inc"), 1, "update reconciles the new company");
await post({ action: "updateContact", id: created.id, firstName: "New", lastName: "Person", email: "new.person@newco.test", company: "RENAMED INC", stage: "Lead" });
assert.equal(companyCount("Renamed Inc"), 1);
const beforeImport = one("SELECT count(*) AS n FROM companies").n;
const imported = await post({ action: "bulkImportContacts", filename: "t.csv", contacts: [
  { firstName: "Imp", lastName: "One", email: "imp1@import.test", company: "Import Co" },
  { firstName: "Imp", lastName: "Two", email: "imp2@import.test", company: "IMPORT CO" },
  { firstName: "Imp", lastName: "Three", email: "imp3@import.test", company: "Company 1" },
  { firstName: "Imp", lastName: "Four", email: "PERSON1@example1.test", company: "" },
] }, owner, 201);
assert.deepEqual({ created: imported.created, updated: imported.updated }, { created: 3, updated: 1 }, "existing emails are found case-insensitively without loading every contact");
assert.equal(one("SELECT count(*) AS n FROM companies").n, beforeImport + 1, "one new company for Import Co; existing Company 1 untouched");
assert.equal(companyCount("import co"), 1);
await post({ action: "bulkImportContacts", filename: "t.csv", contacts: [{ firstName: "Imp", lastName: "One", email: "imp1@import.test", company: "Import Co" }] }, owner, 201);
assert.equal(companyCount("import co"), 1, "re-import is idempotent");
assert.equal(one("SELECT count(*) AS n FROM companies WHERE name='Orphan Holdings'").n, 0, "writes only reconcile the names they touch");

// --- Import preview: which emails already exist ---
assert.deepEqual((await post({ action: "existingEmails", emails: ["IMP1@import.test", "nobody@x.test", "person2@example2.test"] })).existing.sort(), ["imp1@import.test", "person2@example2.test"]);
await post({ action: "existingEmails", emails: Array.from({ length: 5001 }, (_, i) => `x${i}@y.test`) }, owner, 400);

// --- Bulk update: explicit ids (chunked past D1's bound-parameter limit) and "all matching the filter" ---
const bulkIds = Array.from({ length: 120 }, (_, i) => i + 1);
assert.equal((await post({ action: "bulkUpdateContacts", ids: bulkIds, addTag: "Batch" })).count, 120);
assert.equal((await post({ action: "bulkUpdateContacts", ids: bulkIds, addTag: "batch" })).count, 120);
assert.deepEqual(JSON.parse(one("SELECT tags FROM contacts WHERE id=6").tags), ["VIP", "Priority", "Batch"], "tag appended once (case-insensitive)");
await post({ action: "bulkUpdateContacts", ids: [203], addTag: "Fixed" });
assert.deepEqual(JSON.parse(one("SELECT tags FROM contacts WHERE id=203").tags), ["Fixed"], "malformed tags are replaced, not crashed on");
const denverProspects = one("SELECT count(*) AS n FROM contacts WHERE location LIKE '%denver%' AND stage='Prospect'").n;
assert.ok(denverProspects > 0);
assert.equal((await post({ action: "bulkUpdateContacts", filter: { q: "denver", stage: "Prospect" }, stage: "Opportunity" })).count, denverProspects);
assert.equal(one("SELECT count(*) AS n FROM contacts WHERE location='Denver' AND stage='Prospect'").n, 0);
assert.equal(one("SELECT stage FROM contacts WHERE id=2").stage, all.find(row => row.id === 2).stage, "non-matching contacts untouched");
await post({ action: "bulkUpdateContacts", ids: Array.from({ length: 501 }, (_, i) => i + 1), stage: "Lead" }, owner, 400);
await post({ action: "bulkUpdateContacts", filter: { q: "nobody-matches" }, stage: "Lead" }, owner, 404);

// --- Today queue in one request ---
sqlite.exec("INSERT INTO communication_review_items(id,source,sender_email,sender_name,subject,status,created_at) VALUES ('r1','Email','a@b.test','A','Hello','Pending','2026-01-01')");
const todayQueue = await get(opsRoute, "/api/operations?view=today", viewer);
assert.deepEqual(todayQueue.reviewItems.map(item => item.id), ["r1"]);
assert.ok(Array.isArray(todayQueue.cases) && todayQueue.today && !("analytics" in todayQueue));

assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
console.log(`PASS: ${checks} route checks — contact/company paging, totals, filters, search with LIKE escaping and injection attempts, sort allowlist, limit caps, summaries and segment counts, detail reads, pickers, viewer access, read-only GETs, company reconciliation on create/update/import, import preview, bulk updates by ids and by filter, and the Today queue.`);
