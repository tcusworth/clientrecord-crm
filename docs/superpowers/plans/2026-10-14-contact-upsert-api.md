# Contact Upsert API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/v1/contacts/upsert`, which lets the CSI website upsert a contact by email with a note, structured source and attribution, consent handling and named list membership. Add the CRM screens for lists and website submissions.

**Architecture:**
- A pure validator turns the request body into a typed input. A service (`lib/contact-upsert.ts`) builds every write as one atomic D1 `batch()`, using `(SELECT id FROM contacts WHERE email=?)` subqueries so a new contact's ID needn't be known mid-batch.
- The route maps authentication, validation and runtime failures to 401/403/400/413 versus 500/503.
- Lists live in `lib/contact-lists.ts` and feed the Audiences screen and campaign audience matching.

**Tech Stack:** vinext on Cloudflare Workers, D1 (SQLite), TypeScript, Drizzle schema files with hand-written SQL migrations, node test scripts (`scripts/test-*.mjs`) using `scripts/test-helpers.mjs` (`createTestContext`).

**Spec:** `docs/superpowers/specs/2026-10-14-contact-upsert-api-design.md` (read it first; it is authoritative).

## Global Constraints

- Endpoint: `POST /api/v1/contacts/upsert`. Auth: API-key scope `leads.capture` (a `*` key also passes). A session cookie or Access identity must NOT authenticate this endpoint.
- Sources (exact): `contact_form`, `epc_inquiry`, `report_download`, `decoder`, `insights_signup`. `reportName` is required for `report_download`.
- Limits:
  - body ≤ 20 KB (else 413);
  - email ≤ 320, firstName/lastName ≤ 120, fullName ≤ 240, jobTitle ≤ 200, company ≤ 240;
  - note.title ≤ 200, note.body ≤ 10000;
  - reportName ≤ 200, consentText ≤ 1000, referrer ≤ 2000;
  - each utm value ≤ 200;
  - lists ≤ 10 names of 1–120 characters each;
  - submissionId 1–200 characters.
- Blank strings count as absent. Never overwrite an existing value with a blank.
- Status codes:
  - 201 when the contact was created;
  - 200 when it was updated, or `action:"duplicate"` for a repeated submissionId;
  - 400 `{error, fields}` for bad input, 401 for a missing or invalid key, 403 for the wrong scope, 413 for an oversized body;
  - 503 for a D1 overload or timeout (a message matching `/overloaded|timeout|7429|D1_ERROR.*(busy|reset)/i`), 500 for anything else.
  - 5xx body is exactly `{ "error": "Temporary failure; retry." }`.
- Consent:
  - A new contact is subscribed only when consent is true.
  - An existing contact is subscribed by `true` only when currently unsubscribed AND `suppression_reason` is empty AND the email is not in `suppressions`.
  - false or missing never unsubscribes anyone.
- Tasks only for `contact_form` and `epc_inquiry`: title `Respond to {firstName || email} · {label}`, due `date('now')`, owner = the API key's `created_by` (`user.email`), status `Open`. Labels:
  - `contact_form`: Contact form
  - `epc_inquiry`: EPC inquiry
  - `report_download`: Report download
  - `decoder`: Decoder
  - `insights_signup`: Insights signup
- Note activity: type `Note`, text `"{title}\n\n{body}"` trimmed (just whichever is present).
- Code style: match the surrounding files (dense one-line style is normal here). No new dependencies. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The gitleaks hook runs; never use `--no-verify`, and never use bare `git stash`.
- Done means `pnpm test` passes, `pnpm typecheck` is clean, `pnpm lint` shows 0 errors, and `pnpm build` succeeds.

## Review Focus

1. **Concurrent retry:** two calls with the same `submissionId` arrive at the same moment. Expect one to create and the other to return 200 `duplicate`, never a 500. The unique-index violation is caught and answered as a duplicate (Task 3 test).
2. **Email case and whitespace:** `"  Jane.Doe@X.com "` versus a stored `jane.doe@x.com`, or a stored mixed-case address from an old import. Expect the same contact, matched by `lower(email)` (Task 2 test).
3. **List name variants:** `"State of OPA 2026"`, `" state of opa 2026 "` and the same name twice in one call. Expect one list and one membership (Task 2 test).
4. **Non-object JSON body:** `[]`, `null`, `"text"` or `42`. Expect 400, not 500 (Task 3 test).
5. **Consent as a string:** a form posts `"true"`, `"on"`, `"yes"` or `"1"` (and `"false"`, `"off"`, `"no"`, `"0"`). Expect these to read as booleans. Any other non-boolean value returns 400 (Task 1 test).

---

### Task 1: Data model and input validator

**Files:**
- Create: `drizzle/0032_contact_upsert.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 32, tag `0032_contact_upsert`, `"when": 1791592320923`, version "6", breakpoints true)
- Modify: `db/schema.ts` (add `firstSource`, `latestSource` to `contacts`; add `formSubmissions`, `contactLists` and `contactListMembers` tables mirroring the SQL)
- Modify: `app/api/crm/route.ts:13` (`CONTACT_REFERENCES`: add `["contact_list_members","contact_id","delete"]` and `["form_submissions","contact_id","detach"]`)
- Create: `lib/contact-upsert-input.ts`
- Test: `scripts/test-contact-upsert.mjs` (created here; Tasks 2–3 extend it)

Snapshot: copy `drizzle/meta/0031_snapshot.json` to `0032_snapshot.json` and add the new columns and tables, following how 0031 was produced (look at `git show HEAD~0 --stat` history for 0031). If that's impractical, leave a note in the task report; the journal entry is what migrations need.

**Interfaces:**
- Produces:
  ```ts
  export type UpsertSource = "contact_form"|"epc_inquiry"|"report_download"|"decoder"|"insights_signup";
  export const SOURCE_LABELS: Record<UpsertSource,string>;
  export type UpsertInput = { email:string; firstName:string; lastName:string; jobTitle:string; company:string;
    note:{title:string;body:string}|null; source:UpsertSource; reportName:string; consent:boolean|null; consentText:string;
    referrer:string; utm:{source:string;medium:string;campaign:string;term:string;content:string}; lists:string[]; submissionId:string };
  export function parseUpsertInput(body:unknown): { ok:true; value:UpsertInput } | { ok:false; fields:Record<string,string> };
  ```
  `firstName`/`lastName` already have the `fullName` split applied. `lists` are trimmed, de-duplicated case-insensitively, keeping the first spelling. Absent strings are `""`.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE `contacts` ADD `first_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `latest_source` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `form_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text,
	`contact_id` integer,
	`action` text NOT NULL,
	`source` text NOT NULL,
	`report_name` text DEFAULT '' NOT NULL,
	`consent` integer,
	`consent_text` text DEFAULT '' NOT NULL,
	`referrer` text DEFAULT '' NOT NULL,
	`utm_source` text DEFAULT '' NOT NULL,
	`utm_medium` text DEFAULT '' NOT NULL,
	`utm_campaign` text DEFAULT '' NOT NULL,
	`utm_term` text DEFAULT '' NOT NULL,
	`utm_content` text DEFAULT '' NOT NULL,
	`note_title` text DEFAULT '' NOT NULL,
	`lists_json` text DEFAULT '[]' NOT NULL,
	`task_id` integer,
	`api_key_id` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `form_submissions_submission_id_unique` ON `form_submissions` (`submission_id`) WHERE `submission_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `form_submissions_source_idx` ON `form_submissions` (`source`);--> statement-breakpoint
CREATE INDEX `form_submissions_contact_idx` ON `form_submissions` (`contact_id`);--> statement-breakpoint
CREATE INDEX `form_submissions_campaign_idx` ON `form_submissions` (`utm_campaign`);--> statement-breakpoint
CREATE TABLE `contact_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_lists_name_unique` ON `contact_lists` (lower(`name`));--> statement-breakpoint
CREATE TABLE `contact_list_members` (
	`list_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`added_at` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`list_id`, `contact_id`),
	FOREIGN KEY (`list_id`) REFERENCES `contact_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
```

- [ ] **Step 2: Write the failing tests** in `scripts/test-contact-upsert.mjs`

```js
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const { parseUpsertInput } = load("lib/contact-upsert-input.ts");

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
assert.ok(bad({ email: "a@b.co", source: "report_download" }).fields.reportName);
assert.ok(bad({ email: "a@b.co", source: "decoder", consent: "maybe" }).fields.consent);
assert.ok(bad({ email: "a@b.co", source: "decoder", lists: Array.from({ length: 11 }, (_, i) => `L${i}`) }).fields.lists);
assert.ok(bad({ email: "a@b.co", source: "decoder", lists: "State" }).fields.lists);
assert.ok(bad({ email: "a@b.co", source: "decoder", jobTitle: "x".repeat(201) }).fields.jobTitle);
assert.ok(bad({ email: "a@b.co", source: "decoder", note: { body: "x".repeat(10001) } }).fields["note.body"]);
for (const body of [null, [], "text", 42]) assert.equal(parseUpsertInput(body).ok, false);
console.log("contact upsert: schema + validator ok");
```

- [ ] **Step 3: Run it to confirm it fails.** Run `node scripts/test-contact-upsert.mjs`. It should fail to resolve `lib/contact-upsert-input.ts` or a table.

- [ ] **Step 4: Implement `lib/contact-upsert-input.ts`**

```ts
export type UpsertSource="contact_form"|"epc_inquiry"|"report_download"|"decoder"|"insights_signup";
export const SOURCE_LABELS:Record<UpsertSource,string>={contact_form:"Contact form",epc_inquiry:"EPC inquiry",report_download:"Report download",decoder:"Decoder",insights_signup:"Insights signup"};
export type UpsertInput={email:string;firstName:string;lastName:string;jobTitle:string;company:string;note:{title:string;body:string}|null;source:UpsertSource;reportName:string;consent:boolean|null;consentText:string;referrer:string;utm:{source:string;medium:string;campaign:string;term:string;content:string};lists:string[];submissionId:string};
const TRUE=new Set(["true","yes","on","1"]),FALSE=new Set(["false","no","off","0"]);
export function parseUpsertInput(body:unknown):{ok:true;value:UpsertInput}|{ok:false;fields:Record<string,string>}{
  const fields:Record<string,string>={};
  if(!body||typeof body!=="object"||Array.isArray(body))return {ok:false,fields:{body:"Send a JSON object."}};
  const b=body as Record<string,unknown>;
  const text=(key:string,value:unknown,max:number)=>{if(value==null)return "";if(typeof value!=="string"&&typeof value!=="number"){fields[key]="Must be text.";return ""}const v=String(value).trim();if(v.length>max)fields[key]=`At most ${max} characters.`;return v};
  const email=text("email",b.email,320).toLowerCase();
  if(!email)fields.email="Email is required.";else if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fields.email="Enter a valid email address.";
  let firstName=text("firstName",b.firstName,120),lastName=text("lastName",b.lastName,120);
  const fullName=text("fullName",b.fullName,240);
  if(fullName){const [first,...rest]=fullName.split(/\s+/);if(!firstName)firstName=first||"";if(!lastName)lastName=rest.join(" ")}
  const source=text("source",b.source,40) as UpsertSource;
  if(!(source in SOURCE_LABELS))fields.source=`Use one of: ${Object.keys(SOURCE_LABELS).join(", ")}.`;
  const reportName=text("reportName",b.reportName,200);
  if(source==="report_download"&&!reportName)fields.reportName="reportName is required for report_download.";
  let consent:boolean|null=null;
  if(typeof b.consent==="boolean")consent=b.consent;else if(b.consent!=null){const v=String(b.consent).trim().toLowerCase();if(TRUE.has(v))consent=true;else if(FALSE.has(v))consent=false;else fields.consent="Use true or false."}
  let note:UpsertInput["note"]=null;
  if(b.note!=null){if(typeof b.note!=="object"||Array.isArray(b.note))fields.note="Must be an object with title and body.";else{const n=b.note as Record<string,unknown>,title=text("note.title",n.title,200),noteBody=text("note.body",n.body,10000);if(title||noteBody)note={title,body:noteBody}}}
  const u=b.utm&&typeof b.utm==="object"&&!Array.isArray(b.utm)?b.utm as Record<string,unknown>:{};
  if(b.utm!=null&&(typeof b.utm!=="object"||Array.isArray(b.utm)))fields.utm="Must be an object.";
  const utm={source:text("utm.source",u.source,200),medium:text("utm.medium",u.medium,200),campaign:text("utm.campaign",u.campaign,200),term:text("utm.term",u.term,200),content:text("utm.content",u.content,200)};
  let lists:string[]=[];
  if(b.lists!=null){if(!Array.isArray(b.lists))fields.lists="Must be an array of list names.";else if(b.lists.length>10)fields.lists="At most 10 lists.";else{const seen=new Set<string>();for(const raw of b.lists){const name=typeof raw==="string"?raw.trim():"";if(!name||name.length>120){fields.lists="Each list name must be 1–120 characters.";break}if(!seen.has(name.toLowerCase())){seen.add(name.toLowerCase());lists.push(name)}}}}
  const submissionId=text("submissionId",b.submissionId,200);
  const value:UpsertInput={email,firstName,lastName,jobTitle:text("jobTitle",b.jobTitle,200),company:text("company",b.company,240),note,source,reportName,consent,consentText:text("consentText",b.consentText,1000),referrer:text("referrer",b.referrer,2000),utm,lists,submissionId};
  return Object.keys(fields).length?{ok:false,fields}:{ok:true,value};
}
```

- [ ] **Step 5: Update `db/schema.ts`, the journal, the snapshot and `CONTACT_REFERENCES`** as listed under Files.

- [ ] **Step 6: Run the test.** Run `node scripts/test-contact-upsert.mjs` and expect "schema + validator ok". Then run `pnpm test` (the existing contact-delete test must still pass) and `pnpm typecheck`.

- [ ] **Step 7: Commit:** `feat: contact upsert data model and input validation`

---

### Task 2: Upsert service (atomic batch)

**Files:**
- Create: `lib/contact-upsert.ts`
- Test: `scripts/test-contact-upsert.mjs` (append)

**Interfaces:**
- Consumes: `UpsertInput` and `SOURCE_LABELS` from `lib/contact-upsert-input.ts`; `audit(user, action, entityType, entityId, summary, changes)` and `CRMUser` from `lib/crm-auth.ts`.
- Produces:
  ```ts
  export type UpsertResult={contactId:number;action:"created"|"updated"|"duplicate";submissionId:string;lists:{id:number;name:string}[]};
  export async function upsertContact(input:UpsertInput,user:CRMUser):Promise<UpsertResult>;
  ```
  It throws only for runtime or database failures. Validation is already done.

**Algorithm (implement exactly):**
1. If `input.submissionId`: `SELECT contact_id,action,lists_json FROM form_submissions WHERE submission_id=?`. If found, return `{contactId, action:"duplicate", submissionId, lists}`, with the lists re-read by name from `lists_json`.
2. `existing = SELECT id,first_name,last_name,title,company,subscribed,suppression_reason,first_source FROM contacts WHERE lower(email)=?`, plus `suppressed = SELECT 1 FROM suppressions WHERE lower(email)=?`. Check the `suppressions` table's column names in `drizzle/`.
3. Build `statements: D1PreparedStatement[]`, and let `cid = "(SELECT id FROM contacts WHERE lower(email)=?)"` with the email bound.
   - New contact: `INSERT INTO contacts(first_name,last_name,email,company,title,stage,tags,subscribed,lead_source,first_source,latest_source,created_at,updated_at) VALUES (?,?,?,?,?,'Lead','[]',?,?,?,?,datetime('now'),datetime('now'))`. Check the default and format of `tags` in existing inserts (`lib/revenue-ops.ts` captureLead) and match it. `subscribed = consent===true?1:0`. All three source columns get the source value.
   - Existing contact: `UPDATE contacts SET first_name=CASE WHEN ?<>'' THEN ? ELSE first_name END, …(last_name,title,company)…, latest_source=?, first_source=CASE WHEN first_source='' THEN ? ELSE first_source END, subscribed=CASE WHEN ?=1 AND subscribed=0 AND coalesce(suppression_reason,'')='' AND ?=0 THEN 1 ELSE subscribed END, updated_at=datetime('now') WHERE id=?`. Bind the consent-true flag and the `suppressed` flag.
   - Note: `INSERT INTO activities(contact_id,type,note,happened_at) SELECT id,'Note',?,datetime('now') FROM contacts WHERE lower(email)=?`. Check the `activities` columns, and that `logContactActivity` in `lib/services/contacts.ts` doesn't also update `last_contact`. If it does, add the same `UPDATE contacts SET last_contact=…` it performs, so the timeline behaves like other notes.
   - For each list name: `INSERT OR IGNORE INTO contact_lists(name,created_at) VALUES (?,datetime('now'))`. The unique index on `lower(name)` makes a differently cased name a no-op. Then `INSERT OR IGNORE INTO contact_list_members(list_id,contact_id,added_at,source) SELECT l.id,(SELECT id FROM contacts WHERE lower(email)=?),datetime('now'),? FROM contact_lists l WHERE lower(l.name)=lower(?)`.
   - Task (only `contact_form` / `epc_inquiry`): `INSERT INTO tasks(contact_id,title,due_date,owner,status,completed) SELECT id,?,date('now'),?,'Open',0 FROM contacts WHERE lower(email)=?`.
   - Submission: `INSERT INTO form_submissions(id,submission_id,contact_id,action,source,report_name,consent,consent_text,referrer,utm_source,utm_medium,utm_campaign,utm_term,utm_content,note_title,lists_json,task_id,api_key_id,created_at) SELECT ?,?,id,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT max(id) FROM tasks WHERE contact_id=contacts.id AND title=?),?,datetime('now') FROM contacts WHERE lower(email)=?`. Bind `NULL` for an empty submissionId, `NULL` for null consent, and `user.id.replace(/^api:/,"")` for api_key_id. The task subquery yields NULL when no task was made, because that title won't exist; pass the would-be task title either way.
4. `await env.DB.batch(statements)`. This is atomic, so on any error nothing is written.
5. Read back `contactId` (`SELECT id FROM contacts WHERE lower(email)=?`) and the lists (`SELECT id,name FROM contact_lists WHERE lower(name) IN (…)`), ordered as the input.
6. `await audit(user,"contact.upsert","contact",contactId,`${action} contact via website ${SOURCE_LABELS[source]}`,{source,action,submissionId,lists:names})`.
7. Return `{contactId, action: existing?"updated":"created", submissionId, lists}`.

- [ ] **Step 1: Write the failing tests** (append to `scripts/test-contact-upsert.mjs`)

```js
const auth = load("lib/crm-auth.ts");
const { upsertContact } = load("lib/contact-upsert.ts");
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
assert.equal(count("SELECT count(*) FROM tasks WHERE contact_id=?", r.contactId), 0, "downloads create no task");
assert.equal(r.lists[0].name, "State of OPA 2026");
let s = sqlite.prepare("SELECT * FROM form_submissions WHERE submission_id='sub-1'").get();
assert.equal(s.utm_campaign, "opa26"); assert.equal(s.report_name, "State of OPA 2026"); assert.equal(s.consent, 1); assert.equal(s.api_key_id, "key1");

// duplicate submissionId: no new writes
r = await upsertContact(input({ email: "jane@acme.com", source: "report_download", reportName: "State of OPA 2026", note: { title: "again" }, submissionId: "sub-1" }), user);
assert.equal(r.action, "duplicate");
assert.equal(count("SELECT count(*) FROM activities WHERE contact_id=?", r.contactId), 1);
assert.equal(count("SELECT count(*) FROM form_submissions WHERE contact_id=?", r.contactId), 1);

// update: blanks never overwrite, case/whitespace email match, latest vs first source, task for contact_form, list idempotent + case-insensitive
r = await upsertContact(input({ email: "  JANE@acme.COM ", firstName: "", jobTitle: "", company: "Acme Corp", source: "contact_form", consent: false, lists: [" state of opa 2026 ", "Contact requests"] }), user);
assert.equal(r.action, "updated");
c = contact("jane@acme.com");
assert.equal(c.first_name, "Jane"); assert.equal(c.title, "VP"); assert.equal(c.company, "Acme Corp");
assert.equal(c.first_source, "report_download"); assert.equal(c.latest_source, "contact_form");
assert.equal(c.subscribed, 1, "consent false never unsubscribes");
assert.equal(count("SELECT count(*) FROM tasks WHERE contact_id=? AND title LIKE 'Respond to Jane · Contact form'", r.contactId), 1);
assert.equal(count("SELECT count(*) FROM contact_lists"), 2, "State of OPA 2026 (seeded in the Task 1 schema test, reused, never duplicated) + Contact requests");
assert.equal(count("SELECT count(*) FROM contact_list_members WHERE contact_id=?", r.contactId), 2);
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

// atomicity: a failing statement writes nothing
sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON form_submissions BEGIN SELECT RAISE(ABORT,'boom'); END;");
await assert.rejects(() => upsertContact(input({ email: "atomic@x.com", source: "decoder", lists: ["Atomic"] }), user));
assert.equal(contact("atomic@x.com"), undefined); assert.equal(count("SELECT count(*) FROM contact_lists WHERE name='Atomic'"), 0);
sqlite.exec("DROP TRIGGER boom");
console.log("contact upsert: service ok");
```

Adjust the column names after checking the real `contacts` and `suppressions` schemas. If `contacts` has other NOT NULL columns without defaults, include them in the test inserts.

- [ ] **Step 2: Run the test.** Run `node scripts/test-contact-upsert.mjs` and expect it to fail because `lib/contact-upsert.ts` is missing.
- [ ] **Step 3: Implement `lib/contact-upsert.ts`** per the algorithm above, using `import { env } from "cloudflare:workers"`.
- [ ] **Step 4: Run the test** (`node scripts/test-contact-upsert.mjs`) and expect "service ok". Then run `pnpm test`.
- [ ] **Step 5: Commit:** `feat: atomic contact upsert service with lists, consent and submissions`

---

### Task 3: HTTP route, status codes and OpenAPI

**Files:**
- Create: `app/api/v1/contacts/upsert/route.ts`
- Modify: `lib/crm-auth.ts`. Add `apiKeyAccess` (below); `apiKeyUser` stays unchanged.
- Modify: `app/api/openapi/route.ts`. Add the path, request schema and responses; bump `info.version` to "1.2.0".
- Test: `scripts/test-contact-upsert.mjs` (append)

**Interfaces:**
- Consumes: `parseUpsertInput` (Task 1); `upsertContact` and `UpsertResult` (Task 2).
- Produces: `export async function apiKeyAccess(request:Request, scope:string):Promise<{user:CRMUser}|{status:401|403}>` in `lib/crm-auth.ts`:
  - 401 when the bearer is missing, isn't `cr_live_`, or doesn't match an active key;
  - 403 when the key is valid but lacks the scope (and isn't `*`);
  - otherwise the same user object `apiKeyUser` returns. Implement by sharing the lookup with `apiKeyUser`: factor the row query into a private helper and keep `apiKeyUser`'s behaviour identical.

Route logic:

```ts
import { apiKeyAccess } from "@/lib/crm-auth";
import { parseUpsertInput } from "@/lib/contact-upsert-input";
import { upsertContact } from "@/lib/contact-upsert";
const MAX=20*1024,RETRY={error:"Temporary failure; retry."};
const transient=(e:unknown)=>/overloaded|timeout|7429|D1_ERROR.*(busy|reset)/i.test(e instanceof Error?e.message:String(e));
const duplicateClaim=(e:unknown)=>/UNIQUE constraint failed: form_submissions\.submission_id/i.test(e instanceof Error?e.message:String(e));
export async function POST(request:Request){
  const access=await apiKeyAccess(request,"leads.capture");
  if("status" in access)return Response.json({error:access.status===401?"A valid leads.capture API key is required.":"This API key lacks the leads.capture scope."},{status:access.status});
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>MAX)return Response.json({error:"Payload exceeds 20 KB."},{status:413});
  let body:unknown;try{body=JSON.parse(raw)}catch{return Response.json({error:"Body must be valid JSON.",fields:{body:"Invalid JSON."}},{status:400})}
  const parsed=parseUpsertInput(body);
  if(!parsed.ok)return Response.json({error:"Invalid payload.",fields:parsed.fields},{status:400});
  try{const result=await upsertContact(parsed.value,access.user);return Response.json(result,{status:result.action==="created"?201:200})}
  catch(error){
    if(parsed.value.submissionId&&duplicateClaim(error)){try{const result=await upsertContact(parsed.value,access.user);return Response.json(result,{status:200})}catch{}}
    console.error("contact upsert failed",error instanceof Error?error.message:error);
    return Response.json(RETRY,{status:transient(error)?503:500});
  }
}
```

The retry on `duplicateClaim` re-enters `upsertContact`. Step 1 then finds the winning row and returns `duplicate`. This covers Review Focus item 1.

- [ ] **Step 1: Write the failing tests** (append)

```js
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
console.log("contact upsert: http ok");
```

The in-memory SQLite shim runs statements synchronously, so `Promise.all` interleaves only at `await` points. The race test still exercises the duplicate-claim path if both calls pass step 1 before either batch runs. If the shim serialises them fully, the test still asserts the end state (one row; statuses 201 and 200).

- [ ] **Step 2: Run the test** (`node scripts/test-contact-upsert.mjs`) and expect it to fail because the route is missing.
- [ ] **Step 3: Implement `apiKeyAccess`, the route, and the OpenAPI entry.** Document in the OpenAPI entry:
  - every request field, with its limits and the source enum;
  - every response (201 and 200 with an `action` enum, then 400, 401, 403, 413, 500 and 503);
  - the security scheme `bearerAuth`, as the existing records path uses it.
- [ ] **Step 4: Run the test** and expect "http ok". Then run `pnpm test` and `pnpm typecheck`. The existing `apiKeyUser` tests must still pass.
- [ ] **Step 5: Commit:** `feat: POST /api/v1/contacts/upsert with explicit 4xx/5xx contract`

---

### Task 4: Lists service, campaign audience and lists API

**Files:**
- Create: `lib/contact-lists.ts`
- Modify: `app/api/crm/route.ts`
  - `audienceMatch` and `syncCampaign` accept a `list:{id}` audience.
  - The GET payload gains `lists`.
  - New POST actions: `removeListMember` (records.edit), `renameList` (settings.manage) and `deleteList` (settings.manage).
  - Also check the other files that reference `audience` (`app/api/export/route.ts`, `app/api/platform-expansion/route.ts`, `lib/crm-records.ts`). Wherever they resolve `segment:` audiences, add `list:` handling the same way.
- Test: `scripts/test-contact-lists.mjs`

**Interfaces:**
- Consumes: the tables from Task 1.
- Produces:
  ```ts
  export type ContactList={id:number;name:string;memberCount:number;subscribedCount:number;createdAt:string};
  export async function listContactLists():Promise<ContactList[]>;
  export async function listMembers(listId:number):Promise<{contactId:number;name:string;email:string;subscribed:boolean;addedAt:string;source:string}[]>;
  export async function listMemberIds(listId:number):Promise<Set<number>>;
  export async function removeListMember(listId:number,contactId:number):Promise<void>;
  export async function renameList(listId:number,name:string):Promise<void>; // throws Error("A list with that name already exists.") on unique clash, Error("List name must be 1–120 characters.")
  export async function deleteList(listId:number):Promise<void>; // deletes members, then the list
  export async function contactListsFor(contactId:number):Promise<{id:number;name:string}[]>;
  ```
  The CRM GET payload's `lists` is a `ContactList[]`. Each contact in the payload also gains `lists: string[]`, `firstSource` and `latestSource`. Load memberships in one query (`SELECT m.contact_id, l.name FROM contact_list_members m JOIN contact_lists l ON l.id=m.list_id`) and group them; never query per contact.

- [ ] **Step 1: Write the failing test** `scripts/test-contact-lists.mjs`. It should:
  - seed 3 contacts (two subscribed, one suppressed or unsubscribed) and a list holding all 3;
  - assert `listContactLists()` returns `memberCount` 3 and `subscribedCount` 2;
  - assert that `audienceMatch` for `list:{id}` selects exactly the 2 subscribed members. `audienceMatch` is module-private, so test through `syncCampaign` with a stubbed `fetch` capturing Resend calls, or export `audienceMatch` for tests, following the file's existing export style;
  - assert `removeListMember` reduces the count;
  - assert renaming to an existing name (any case) throws, and that a name of 0 or 121 characters throws;
  - assert `deleteList` removes the memberships but not the contacts;
  - assert a viewer gets 403 on `removeListMember` and an editor gets 403 on `deleteList`, through `app/api/crm/route.ts` POST, using the session headers from `scripts/test-integration-hardening.mjs`;
  - assert the GET payload includes `lists` and contacts carry `lists`, `firstSource` and `latestSource`.
- [ ] **Step 2: Run it** (`node scripts/test-contact-lists.mjs`) and expect it to fail.
- [ ] **Step 3: Implement `lib/contact-lists.ts` and the `app/api/crm/route.ts` changes.**
- [ ] **Step 4: Run the test**, then `pnpm test` and `pnpm typecheck`.
- [ ] **Step 5: Commit:** `feat: contact lists as campaign audiences`

---

### Task 5: Screens

**Files:**
- Modify: `app/page.tsx`
  - The `Audiences` component gains a "Lists" panel showing a table of name, members and subscribed count. Each list has "View", a dialog listing members, each with a remove button. Owners and admins also get Rename and Delete, with `window.confirm` naming the list.
  - The campaign audience `<select>` gains one `<option value={`list:${id}`}>List · {name} ({subscribedCount})</option>` per list.
  - `audienceCount` handles `list:`.
  - The `CRMData` type gains `lists`.
- Modify: `components/contact-workspace.tsx`. The contact record shows list chips (using the `Badge` component) and "First source / Latest source" with human labels from `SOURCE_LABELS`.
- Modify: `app/api/revenue-ops/route.ts`. The GET adds `submissions`, the latest 200 rows of `form_submissions` joined to contact names.
- Modify: `components/revenue-ops.tsx`. The leads section gains a "Website submissions" table showing date, contact, source label, report, `utm_campaign` (with `utm_source` as a muted subtitle) and consent (Yes/No/—), with a source filter `<select>`.
- Test: extend `scripts/test-contact-lists.mjs`. Assert the revenue-ops GET includes `submissions` with `source` and `utm_campaign` fields, for an editor session.

UI rules:
- Use the existing Harbor tokens and primitives (`Panel`, `Badge`, `Button`, `.universal-table`, `Heading`).
- No new colours; keep the files' one-line style.
- Viewers see no remove, rename or delete buttons.
- Empty states read "No lists yet. Lists are created when website forms add contacts to them." and "No website submissions yet."

- [ ] **Step 1: Write the failing assertion** for revenue-ops `submissions`, then run `node scripts/test-contact-lists.mjs` and expect it to fail.
- [ ] **Step 2: Implement the API and UI changes.**
- [ ] **Step 3: Run `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 errors) and `pnpm build`.**
- [ ] **Step 4: Commit:** `feat: lists, sources and website submissions in the CRM screens`

---

### Task 6: Docs and full verification

**Files:**
- Modify: `README.md`. In the API section, document `POST /api/v1/contacts/upsert`:
  - scope `leads.capture`;
  - a full request example (curl with a placeholder key `cr_live_REPLACE_ME`);
  - the response table;
  - "send a unique `submissionId` per submission; treat 5xx as retry and 4xx as a payload bug".
  - Note that `/api/v1/*` is already on the Access bypass.

- [ ] **Step 1: Write the README section.**
- [ ] **Step 2: Run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`** and `pnpm --filter clientrecord-mcp typecheck`. Expect all to pass, with 0 lint errors.
- [ ] **Step 3: Commit:** `docs: contact upsert API`
