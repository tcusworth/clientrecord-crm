import assert from "node:assert/strict";
import { applyMigrations, createSqlite, createTestContext, migrationFiles } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
env.BUCKET = { async get(key) { return key === "transcripts/secret.txt" ? { text: async () => "Decision: Keep the board plan confidential\nNext step: Send the confidential plan" } : null; } };
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const owner = "owner@example.com", admin = "admin@example.com", editor = "editor@example.com", viewer = "viewer@example.com";
const SECRET = "Secret Board MSA";
sqlite.exec(`
INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('${admin}','Ada','admin','{}','now','now'),('${editor}','Eddie','editor','{}','now','now'),('${viewer}','Vera','viewer','{}','now','now');
INSERT INTO ai_settings(id,allow_sensitive_sources,updated_at) VALUES (1,1,'now');
INSERT INTO companies(id,name,updated_at) VALUES (1,'Acme','now'),(2,'Globex','now');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Casey','Client','casey@acme.test','Acme','now','now'),(2,'Gary','Globex','gary@globex.test','Globex','now','now'),(3,'Dana','Dup','dana@acme.test','Acme','now','now');
INSERT INTO deals(id,name,company,company_id,contact_id,stage,status,created_at,updated_at) VALUES (1,'Acme expansion','Acme',1,1,'Proposal','Open','now','now');
INSERT INTO client_documents(id,company_id,deal_id,title,category,status,sensitive,latest_version,created_by,created_at,updated_at) VALUES ('doc-s',1,1,'${SECRET}','Contract','Active',1,1,'${owner}','2026-09-01','2026-09-01'),('doc-p',1,1,'Public pricing sheet','Correspondence','Active',0,1,'${owner}','2026-09-01','2026-09-01');
INSERT INTO document_versions(id,document_id,version,object_key,filename,content_type,size,checksum,uploaded_by,uploaded_at) VALUES ('ver-s','doc-s',1,'transcripts/secret.txt','secret.txt','text/plain',90,'h','${owner}','2026-09-01'),('ver-p','doc-p',1,'docs/public.txt','public.txt','text/plain',10,'h','${owner}','2026-09-01');
INSERT INTO deal_meetings(id,deal_id,company_id,subject,status,starts_at,owner,summary,transcript_document_id,source_provider,created_by,created_at,updated_at) VALUES ('meet-1',1,1,'Board sync','Completed','2026-09-10T15:00:00Z','${owner}','Discussed rollout.','doc-s','Manual','${owner}','2026-09-10','2026-09-10');
`);
const call = (route, path) => ({
  get: (email, query = "") => route.GET(new Request(`https://crm.example.com/api/${path}${query}`, { headers: headers(email) })),
  post: (email, body) => route.POST(new Request(`https://crm.example.com/api/${path}`, { method: "POST", headers: headers(email), body: JSON.stringify(body) })),
});
async function expectStatus(promise, status, label) { const response = await promise, body = await response.clone().json().catch(() => ({})); assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`); return body; }
async function json(promise, label) { const response = await promise, text = await response.text(); assert.equal(response.status, 200, `${label}: ${text.slice(0, 400)}`); return { body: JSON.parse(text), text }; }
const failures = [];
async function part(name, fn) { try { await fn(); console.log(`  ok   ${name}`); } catch (error) { failures.push(name); console.log(`  FAIL ${name}\n       ${String(error?.message || error).split("\n").slice(0, 4).join("\n       ")}`); } }
const artifactSensitive = id => sqlite.prepare("SELECT sensitive FROM ai_artifacts WHERE id=?").get(id).sensitive;

// #8 Mailbox sync reads the org-wide connected mailbox: integrations.manage only.
await part("#8 mailbox sync requires integrations.manage", async () => {
  for (const provider of ["google", "microsoft"]) {
    const route = call(load(`app/api/${provider}/sync/route.ts`), `${provider}/sync`);
    await expectStatus(route.post(editor, {}), 403, `${provider} editor`);
    for (const email of [admin, owner]) assert.notEqual((await route.post(email, {})).status, 403, `${provider} ${email} passes the permission check`);
  }
});

// #1 AI artifacts derived from sensitive documents, and sensitive document titles, are hidden without documents.manage_sensitive.
const followUps = call(load("app/api/follow-up-drafts/route.ts"), "follow-up-drafts"), governance = call(load("app/api/ai-governance/route.ts"), "ai-governance"), workspace = call(load("app/api/ai-workspace/route.ts"), "ai-workspace");
const proposals = call(load("app/api/ai-proposals/route.ts"), "ai-proposals"), revenue = call(load("app/api/ai-revenue-intelligence/route.ts"), "ai-revenue-intelligence"), recordFields = call(load("app/api/ai-record-fields/route.ts"), "ai-record-fields");
const dealWorkspace = call(load("app/api/deal-workspace/route.ts"), "deal-workspace"), sales = call(load("app/api/sales/route.ts"), "sales");
let secretDraft = "", ownerPlan = "", ownerNegotiation = "";
await part("#1 follow-up draft from a sensitive transcript is hidden from editor/viewer, visible to owner", async () => {
  secretDraft = (await expectStatus(followUps.post(owner, { action: "generate", dealId: 1, sourceType: "transcript", sourceId: "doc-s" }), 200, "owner generates from sensitive transcript")).artifact.id;
  assert.equal(artifactSensitive(secretDraft), 1, "artifact is marked sensitive");
  for (const email of [editor, viewer]) { const { body, text } = await json(followUps.get(email, "?dealId=1"), `${email} drafts`); assert.ok(!body.drafts.some(item => item.id === secretDraft), `${email} must not see the sensitive draft`); assert.ok(!text.includes("confidential"), `${email} must not see sensitive content`); }
  assert.ok((await json(followUps.get(owner, "?dealId=1"), "owner drafts")).body.drafts.some(item => item.id === secretDraft), "owner sees the sensitive draft");
  assert.notEqual((await followUps.post(editor, { action: "review", dealId: 1, artifactId: secretDraft, status: "Accepted" })).status, 200, "editor cannot review a draft they cannot see");
  assert.equal(sqlite.prepare("SELECT review_status AS s FROM ai_artifacts WHERE id=?").get(secretDraft).s, "Draft");
});
await part("#1 follow-up drafts from a meeting do not leak the sensitive transcript title", async () => {
  const draft = await expectStatus(followUps.post(editor, { action: "generate", dealId: 1, sourceType: "meeting", sourceId: "meet-1" }), 200, "editor meeting draft");
  assert.ok(!JSON.stringify(draft).includes(SECRET), "editor draft response has no sensitive title");
  assert.equal(artifactSensitive(draft.artifact.id), 0, "editor draft excluded the sensitive transcript");
  assert.ok(!sqlite.prepare("SELECT group_concat(excerpt) AS e FROM ai_artifact_sources WHERE artifact_id=?").get(draft.artifact.id).e.includes(SECRET));
  const ownerDraft = await expectStatus(followUps.post(owner, { action: "generate", dealId: 1, sourceType: "meeting", sourceId: "meet-1", force: true }), 200, "owner meeting draft");
  assert.equal(artifactSensitive(ownerDraft.artifact.id), 1, "owner meeting draft that saw the sensitive title is sensitive");
});
await part("#1 ai-workspace account plan / negotiation exclude sensitive docs for editors and mark owner artifacts sensitive", async () => {
  ownerPlan = (await expectStatus(workspace.post(owner, { action: "generateAccountPlan", companyId: 1 }), 200, "owner plan")).artifact.id;
  const negotiation = await expectStatus(workspace.post(owner, { action: "generateNegotiation", dealId: 1 }), 200, "owner negotiation");
  ownerNegotiation = negotiation.artifact.id;
  assert.ok(JSON.stringify(negotiation).includes(SECRET), "owner negotiation evidence cites the sensitive contract (sanity)");
  assert.equal(artifactSensitive(ownerPlan), 1, "owner account plan is sensitive");
  assert.equal(artifactSensitive(ownerNegotiation), 1, "owner negotiation is sensitive");
  const { body, text } = await json(workspace.get(editor), "editor workspace");
  assert.ok(!body.artifacts.some(item => [ownerPlan, ownerNegotiation].includes(item.id)), "editor does not list sensitive analyses");
  assert.ok(!text.includes(SECRET), "editor workspace has no sensitive title");
  assert.ok((await json(workspace.get(owner), "owner workspace")).body.artifacts.some(item => item.id === ownerNegotiation), "owner lists sensitive analysis");
  assert.notEqual((await workspace.post(editor, { action: "review", artifactId: ownerNegotiation, status: "Accepted" })).status, 200, "editor cannot review hidden analysis");
  const editorNegotiation = await expectStatus(workspace.post(editor, { action: "generateNegotiation", dealId: 1 }), 200, "editor negotiation");
  assert.ok(!JSON.stringify(editorNegotiation).includes(SECRET), "editor-generated analysis excludes the sensitive title");
  assert.equal(artifactSensitive(editorNegotiation.artifact.id), 0);
});
await part("#1 ai-governance hides sensitive artifacts and blocks reviewing them", async () => {
  const { body, text } = await json(governance.get(editor), "editor governance");
  assert.ok(!body.artifacts.some(item => [secretDraft, ownerPlan, ownerNegotiation].includes(item.id)), "editor governance list excludes sensitive artifacts");
  assert.ok(!text.includes(SECRET) && !text.includes("confidential"), "editor governance has no sensitive content");
  assert.ok((await json(governance.get(owner), "owner governance")).body.artifacts.some(item => item.id === secretDraft), "owner governance lists sensitive artifact");
  await expectStatus(governance.post(editor, { action: "reviewArtifact", id: secretDraft, status: "Edited", contentJson: "{}" }), 404, "editor edit of hidden artifact");
  await expectStatus(governance.post(owner, { action: "reviewArtifact", id: secretDraft, status: "Accepted" }), 200, "owner review");
});
await part("#1 proposals, revenue intelligence, record fields and meeting prep hide sensitive artifacts", async () => {
  sqlite.exec(`INSERT INTO ai_artifacts(id,feature,entity_type,entity_id,content_json,original_content_json,provider,model,input_hash,generated_by,generated_at,sensitive) VALUES
    ('prop-s','proposal-draft','deal','1','{}','{}','clientrecord','m','h','${owner}','2026-09-24',1),('rev-s','deal-review','deal','1','{}','{}','clientrecord','m','h','${owner}','2026-09-24',1),
    ('rf-s','record-fields-contact','contact','1','{}','{}','clientrecord','m','h','${owner}','2026-09-24',1),('prep-s','meeting-prep','meeting','1:deal','{}','{}','clientrecord','m','h','${owner}','2026-09-24',1)`);
  const views = { proposals: async email => (await json(proposals.get(email, "?dealId=1"), "proposals")).body.drafts.map(item => item.id), revenue: async email => (await json(revenue.get(email), "revenue")).body.reviews.map(item => item.id), recordFields: async email => [(await json(recordFields.get(email, "?entityType=contact&entityId=1"), "record fields")).body.artifact?.id], meetingPrep: async email => Object.values((await json(dealWorkspace.get(email, "?dealId=1"), "deal workspace")).body.meetingBriefs).map(item => item.id) };
  const ids = { proposals: "prop-s", revenue: "rev-s", recordFields: "rf-s", meetingPrep: "prep-s" };
  for (const [name, view] of Object.entries(views)) { assert.ok(!(await view(editor)).includes(ids[name]), `${name}: editor must not see ${ids[name]}`); assert.ok((await view(owner)).includes(ids[name]), `${name}: owner sees ${ids[name]}`); }
  for (const [label, promise] of [["proposal review", proposals.post(editor, { action: "review", dealId: 1, artifactId: "prop-s", status: "Accepted" })], ["revenue review", revenue.post(editor, { action: "review", artifactId: "rev-s", status: "Accepted" })], ["record fields review", recordFields.post(editor, { action: "review", entityType: "contact", entityId: 1, artifactId: "rf-s", status: "Rejected" })], ["meeting brief review", dealWorkspace.post(editor, { action: "reviewMeetingBrief", dealId: 1, id: "prep-s", status: "Accepted" })]]) assert.notEqual((await promise).status, 200, `${label} of hidden artifact`);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM ai_artifacts WHERE id IN ('prop-s','rev-s','rf-s','prep-s') AND review_status!='Draft'").get().n, 0, "hidden artifacts unchanged");
});
await part("#1 sensitive document titles do not leak through deal workspace meetings or the account timeline", async () => {
  const deal = await json(dealWorkspace.get(editor, "?dealId=1"), "editor deal workspace");
  assert.ok(!deal.text.includes(SECRET), "editor deal workspace has no sensitive title");
  assert.equal(deal.body.meetings.find(item => item.id === "meet-1").transcript_title, null);
  assert.ok((await json(dealWorkspace.get(owner, "?dealId=1"), "owner deal workspace")).text.includes(SECRET), "owner still sees the title");
  const timeline = await json(sales.get(editor, "?account=1"), "editor timeline");
  assert.ok(!timeline.text.includes(SECRET), "editor timeline has no sensitive title");
  assert.ok(timeline.text.includes("Public pricing sheet"), "non-sensitive documents still appear");
  assert.ok((await json(sales.get(owner, "?account=1"), "owner timeline")).text.includes(SECRET));
});
await part("#1 linking a sensitive transcript to a meeting requires documents.manage_sensitive", async () => {
  const meeting = transcriptDocumentId => ({ action: "saveMeeting", dealId: 1, subject: "Pricing call", startsAt: "2026-09-20T15:00:00Z", status: "Completed", transcriptDocumentId });
  await expectStatus(dealWorkspace.post(editor, meeting("doc-s")), 403, "editor links sensitive transcript");
  await expectStatus(dealWorkspace.post(editor, meeting("doc-p")), 200, "editor links public transcript");
  await expectStatus(dealWorkspace.post(owner, meeting("doc-s")), 200, "owner links sensitive transcript");
  await expectStatus(dealWorkspace.post(editor, { ...meeting("doc-s"), id: "meet-1", subject: "Board sync" }), 200, "editor re-saving an existing link keeps it");
});
await part("#1 migration adds ai_artifacts.sensitive and backfills it from existing sources", async () => {
  const files = migrationFiles(), base = files.filter(file => file <= "0027_record_list_indexes.sql"), added = files.filter(file => file > "0027_record_list_indexes.sql");
  assert.ok(added.length, "a new migration exists");
  const legacy = createSqlite({ migrations: base });
  legacy.exec(`INSERT INTO companies(id,name,updated_at) VALUES (1,'Acme','now'),(2,'Globex','now');
    INSERT INTO deals(id,name,company,company_id,created_at,updated_at) VALUES (1,'A','Acme',1,'now','now'),(2,'G','Globex',2,'now','now');
    INSERT INTO client_documents(id,company_id,deal_id,title,sensitive,created_by,created_at,updated_at) VALUES ('doc-s',1,1,'S',1,'o','now','now'),('doc-p',2,2,'P',0,'o','now','now');
    INSERT INTO deal_meetings(id,deal_id,subject,starts_at,owner,transcript_document_id,created_by,created_at,updated_at) VALUES ('m-s',1,'M','now','o','doc-s','o','now','now'),('m-p',2,'M','now','o','doc-p','o','now','now');
    INSERT INTO ai_artifacts(id,feature,entity_type,entity_id,content_json,original_content_json,provider,model,input_hash,generated_by,generated_at) VALUES
      ('t-s','follow-up-draft','deal','1:transcript:doc-s','{}','{}','p','m','h','o','now'),('t-p','follow-up-draft','deal','2:transcript:doc-p','{}','{}','p','m','h','o','now'),
      ('m-s','follow-up-draft','deal','1:meeting:m-s','{}','{}','p','m','h','o','now'),('m-p','follow-up-draft','deal','2:meeting:m-p','{}','{}','p','m','h','o','now'),
      ('ap-s','account-plan','company','1','{}','{}','p','m','h','o','now'),('ap-p','account-plan','company','2','{}','{}','p','m','h','o','now'),
      ('ng-s','negotiation-intelligence','deal','1','{}','{}','p','m','h','o','now'),('dr-p','deal-review','deal','1','{}','{}','p','m','h','o','now');
    INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,content_hash) VALUES ('t-s','transcript','doc-s','h'),('t-p','transcript','doc-p','h'),('m-s','meeting','m-s','h'),('m-p','meeting','m-p','h');`);
  applyMigrations(legacy, added);
  const flags = Object.fromEntries(legacy.prepare("SELECT id,sensitive FROM ai_artifacts").all().map(row => [row.id, row.sensitive]));
  assert.deepEqual(flags, { "t-s": 1, "t-p": 0, "m-s": 1, "m-p": 0, "ap-s": 1, "ap-p": 0, "ng-s": 1, "dr-p": 0 });
});

// #4 Customer portal links: contact/company match, bounded expiry, permission allowlist, revoke, safe listing.
const platform = call(load("app/api/platform-expansion/route.ts"), "platform-expansion"), portal = load("app/api/portal/route.ts");
const portalGet = token => portal.GET(new Request("https://crm.example.com/api/portal", { headers: { "x-portal-token": token } }));
const days = (iso, from = Date.now()) => (Date.parse(iso) - from) / 86400000;
await part("#4 portal link contact must belong to the company", async () => {
  await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 2 }), 400, "Globex contact on Acme");
  await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1 }), 201, "Acme contact on Acme");
});
await part("#4 portal link expiry defaults to 90 days and is bounded", async () => {
  const created = await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1 }), 201, "default expiry");
  const expiresAt = sqlite.prepare("SELECT expires_at AS e FROM customer_portal_access WHERE id=?").get(created.id).e;
  assert.ok(expiresAt && Math.abs(days(expiresAt) - 90) < 0.01, `default expiry is 90 days, got ${expiresAt}`);
  const inDays = n => new Date(Date.now() + n * 86400000).toISOString();
  await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1, expiresAt: inDays(400) }), 400, "over 365 days");
  await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1, expiresAt: inDays(-1) }), 400, "past date");
  await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1, expiresAt: "not a date" }), 400, "invalid date");
  const custom = await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1, expiresAt: inDays(30) }), 201, "30 days");
  assert.ok(Math.abs(days(sqlite.prepare("SELECT expires_at AS e FROM customer_portal_access WHERE id=?").get(custom.id).e) - 30) < 0.01);
});
await part("#4 portal permissions are limited to the names the portal checks", async () => {
  await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1, permissions: "cases, admin" }), 400, "unknown permission");
  const limited = await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1, permissions: "cases, documents" }), 201, "subset");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT permissions_json AS p FROM customer_portal_access WHERE id=?").get(limited.id).p), ["cases", "documents"]);
  const fallback = await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1 }), 201, "default permissions");
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT permissions_json AS p FROM customer_portal_access WHERE id=?").get(fallback.id).p), ["cases", "documents", "onboarding", "knowledge"]);
});
await part("#4 revoking a portal link makes /api/portal reject its token", async () => {
  const created = await expectStatus(platform.post(editor, { action: "createPortalAccess", companyId: 1, contactId: 1 }), 201, "create");
  assert.equal((await portalGet(created.token)).status, 200, "active link works");
  await expectStatus(platform.post(viewer, { action: "revokePortalAccess", id: created.id }), 403, "viewer revoke");
  await expectStatus(platform.post(editor, { action: "revokePortalAccess", id: created.id }), 200, "editor revoke");
  assert.equal(sqlite.prepare("SELECT status FROM customer_portal_access WHERE id=?").get(created.id).status, "Revoked");
  assert.equal((await portalGet(created.token)).status, 401, "revoked link is rejected");
  assert.ok(sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='portal.access.revoke' AND entity_id=?").get(created.id).n >= 1, "revoke is audited");
  await expectStatus(platform.post(editor, { action: "revokePortalAccess", id: "missing" }), 400, "unknown link");
});
await part("#4 legacy links without expiry keep working and the list never exposes token material", async () => {
  const { sha256 } = load("lib/crm-auth.ts"), token = "crp_legacytoken000000000000000000000";
  sqlite.prepare("INSERT INTO customer_portal_access(id,company_id,contact_id,token_hash,status,expires_at,created_at) VALUES ('legacy',1,1,?,'Active',NULL,'2025-01-01')").run(await sha256(token));
  assert.equal((await portalGet(token)).status, 200, "legacy link still works");
  const { body, text } = await json(platform.get(owner), "platform list");
  const legacy = body.portalAccess.find(item => item.id === "legacy");
  assert.ok(legacy && legacy.expires_at === null && "last_used_at" in legacy && legacy.status === "Active", "legacy link listed with no expiry");
  for (const row of sqlite.prepare("SELECT token_hash AS h FROM customer_portal_access").all()) assert.ok(!text.includes(row.h), "token hash never listed");
  assert.ok(!text.includes("crp_") && !/token/i.test(Object.keys(legacy).join(",")), "no token fields listed");
});

// #2 The full JSON backup is owner-only.
await part("#2 export type=backup is owner-only; CSV exports unchanged", async () => {
  const exporter = call(load("app/api/export/route.ts"), "export");
  await expectStatus(exporter.get(admin, "?type=backup"), 403, "admin backup");
  assert.equal((await exporter.get(owner, "?type=backup")).status, 200, "owner backup");
  const csv = await exporter.get(admin, "?type=contacts");
  assert.equal(csv.status, 200, "admin contacts CSV");
  assert.match(await csv.text(), /casey@acme\.test/);
});

// #12 Merging contacts deletes one, so it needs records.delete and must re-point every reference.
await part("#12 mergeContacts requires records.delete and re-points every contact reference", async () => {
  const crm = call(load("app/api/crm/route.ts"), "crm");
  sqlite.exec(`
    INSERT INTO automation_sequences(id,name,created_at,updated_at) VALUES (1,'Seq','now','now');
    INSERT INTO partner_companies(id,name,owner,created_at,updated_at) VALUES ('p1','Partner','${owner}','now','now');
    INSERT INTO custom_field_definitions(id,entity_type,name,field_key,field_type,options,created_at) VALUES (1,'contact','Tier','tier','text','[]','now'),(2,'contact','Region','region','text','[]','now');
    INSERT INTO custom_relationship_types(id,name,from_type,to_type,from_label,to_label,created_by,created_at,updated_at) VALUES ('rt','Knows','contact','company','knows','known by','${owner}','now','now');
    INSERT INTO deals(id,name,company,company_id,contact_id,stage,status,created_at,updated_at) VALUES (2,'Dup deal','Acme',1,3,'Lead','Open','now','now');
    UPDATE companies SET primary_contact_id=3 WHERE id=1;
    INSERT INTO activities(contact_id,type,note,happened_at) VALUES (3,'Call','dup call','now');
    INSERT INTO tasks(contact_id,title,due_date) VALUES (3,'Dup task','2026-10-01');
    INSERT INTO automation_enrollments(sequence_id,contact_id,next_run_at,enrolled_at) VALUES (1,3,'now','now');
    INSERT INTO sync_records(provider,external_id,item_type,contact_id,occurred_at,created_at) VALUES ('google','x1','email',3,'now','now');
    INSERT INTO account_stakeholders(company_id,contact_id,role,notes) VALUES (1,1,'Champion','keep'),(1,3,'Buyer','dup'),(2,3,'User','only dup');
    UPDATE client_documents SET contact_id=3 WHERE id='doc-p';
    INSERT INTO deal_activities(deal_id,contact_id,type,body,owner,happened_at,created_at,updated_at) VALUES (1,3,'Call','b','${owner}','now','now','now');
    INSERT INTO deal_stakeholders(deal_id,contact_id,role,notes,is_primary,active,created_at,updated_at) VALUES (1,1,'Champion','keep notes',0,1,'now','now'),(1,3,'Economic Buyer','dup notes',1,1,'now','now'),(2,3,'User','',0,1,'now','now');
    INSERT INTO deal_meeting_attendees(meeting_id,contact_id,created_at) VALUES ('meet-1',3,'now');
    INSERT INTO inbox_messages(id,from_email,contact_id,occurred_at,created_at,updated_at) VALUES ('in-1','dana@acme.test',3,'now','now','now');
    INSERT INTO lead_intakes(id,email,contact_id,duplicate_contact_id,received_at) VALUES ('lead-1','dana@acme.test',3,3,'now');
    INSERT INTO customer_portal_access(id,company_id,contact_id,token_hash,created_at) VALUES ('pa-dup',1,3,'hash-dup','now');
    INSERT INTO field_captures(id,type,contact_id,captured_by,captured_at) VALUES ('fc-dup','Quick note',3,'${owner}','now');
    INSERT INTO partner_contacts(id,partner_company_id,contact_id,first_name,last_name,email,created_at,updated_at) VALUES ('pc-dup','p1',3,'Dana','Dup','dana-partner@acme.test','now','now');
    INSERT INTO service_cases(id,case_number,subject,contact_id,created_at,updated_at) VALUES ('case-dup','CR-1','Help',3,'now','now');
    INSERT INTO communication_review_items(id,source,contact_id,created_at) VALUES ('cri-dup','google',3,'now');
    INSERT INTO custom_field_values(definition_id,entity_type,entity_id,value,updated_at) VALUES (1,'contact',1,'Gold','now'),(1,'contact',3,'Silver','now'),(2,'contact',3,'West','now');
    INSERT INTO ai_record_fields(id,entity_type,entity_id,field_key,value_json,updated_by,updated_at) VALUES ('arf-keep','contact','1','persona','"Keep"','${owner}','now'),('arf-dup','contact','3','persona','"Dup"','${owner}','now'),('arf-only','contact','3','seniority','"VP"','${owner}','now');
    INSERT INTO notifications(owner_email,kind,title,entity_type,entity_id,created_at) VALUES ('${owner}','reply','Dana replied','contact','3','now');
    INSERT INTO custom_relationships(id,relationship_type_id,from_entity_type,from_entity_id,to_entity_type,to_entity_id,created_by,created_at) VALUES ('rel-dup','rt','contact','3','company','2','${owner}','now');`);
  const contactRefs = sqlite.prepare("SELECT m.name AS tbl,f.\"from\" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f.\"table\"='contacts'").all();
  const polymorphic = [["custom_field_values", "entity_type='contact' AND entity_id=?"], ["ai_record_fields", "entity_type='contact' AND entity_id=?"], ["notifications", "entity_type='contact' AND entity_id=?"], ["custom_relationships", "(from_entity_type='contact' AND from_entity_id=?) OR (to_entity_type='contact' AND to_entity_id=?)"]];
  const refsTo = id => [...contactRefs.map(({ tbl, col }) => [`${tbl}.${col}`, sqlite.prepare(`SELECT count(*) AS n FROM "${tbl}" WHERE "${col}"=?`).get(id).n]), ...polymorphic.map(([tbl, where]) => [tbl, sqlite.prepare(`SELECT count(*) AS n FROM ${tbl} WHERE ${where}`).get(...(where.includes("to_entity_id") ? [String(id), String(id)] : [String(id)])).n])];
  for (const [ref, n] of refsTo(3)) assert.ok(n > 0, `test seeds a reference in ${ref}`);
  await expectStatus(crm.post(editor, { action: "mergeContacts", keepId: 1, mergeId: 3 }), 403, "editor merge");
  assert.ok(sqlite.prepare("SELECT id FROM contacts WHERE id=3").get(), "editor merge changed nothing");
  await expectStatus(crm.post(owner, { action: "mergeContacts", keepId: 1, mergeId: 3 }), 200, "owner merge");
  assert.equal(sqlite.prepare("SELECT id FROM contacts WHERE id=3").get(), undefined, "merged contact deleted");
  const orphans = refsTo(3).filter(([, n]) => n > 0);
  assert.deepEqual(orphans, [], "no references to the merged contact remain");
  for (const [tbl, col, where] of [["activities", "contact_id", "note='dup call'"], ["tasks", "contact_id", "title='Dup task'"], ["deals", "contact_id", "id=2"], ["companies", "primary_contact_id", "id=1"], ["client_documents", "contact_id", "id='doc-p'"], ["inbox_messages", "contact_id", "id='in-1'"], ["lead_intakes", "duplicate_contact_id", "id='lead-1'"], ["customer_portal_access", "contact_id", "id='pa-dup'"], ["field_captures", "contact_id", "id='fc-dup'"], ["partner_contacts", "contact_id", "id='pc-dup'"], ["service_cases", "contact_id", "id='case-dup'"], ["communication_review_items", "contact_id", "id='cri-dup'"], ["deal_meeting_attendees", "contact_id", "meeting_id='meet-1'"], ["deal_activities", "contact_id", "body='b'"], ["sync_records", "contact_id", "external_id='x1'"], ["automation_enrollments", "contact_id", "sequence_id=1"]])
    assert.equal(sqlite.prepare(`SELECT ${col} AS c FROM ${tbl} WHERE ${where}`).get().c, 1, `${tbl}.${col} re-pointed to the kept contact`);
  const dealStake = sqlite.prepare("SELECT role,notes,is_primary AS p FROM deal_stakeholders WHERE deal_id=1 AND contact_id=1").get();
  assert.equal(dealStake.role, "Champion"); assert.match(dealStake.notes, /keep notes/); assert.match(dealStake.notes, /dup notes/); assert.equal(dealStake.p, 1, "primary flag carried over");
  assert.ok(sqlite.prepare("SELECT 1 FROM deal_stakeholders WHERE deal_id=2 AND contact_id=1").get(), "non-conflicting deal stakeholder moved");
  assert.match(sqlite.prepare("SELECT notes FROM account_stakeholders WHERE company_id=1 AND contact_id=1").get().notes, /dup/);
  assert.ok(sqlite.prepare("SELECT 1 FROM account_stakeholders WHERE company_id=2 AND contact_id=1").get(), "non-conflicting account stakeholder moved");
  assert.deepEqual(sqlite.prepare("SELECT definition_id AS d,value FROM custom_field_values WHERE entity_type='contact' AND entity_id=1 ORDER BY definition_id").all().map(row => [row.d, row.value]), [[1, "Gold"], [2, "West"]], "custom fields merged, kept values win");
  assert.deepEqual(sqlite.prepare("SELECT field_key AS k,value_json AS v FROM ai_record_fields WHERE entity_type='contact' AND entity_id='1' ORDER BY field_key").all().map(row => [row.k, row.v]), [["persona", '"Keep"'], ["seniority", '"VP"']], "AI record fields merged, kept values win");
  assert.equal(sqlite.prepare("SELECT from_entity_id AS f FROM custom_relationships WHERE id='rel-dup'").get().f, "1");
  assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0, "FK integrity");
});

if (failures.length) { console.error(`\nFAIL: ${failures.length} authorization hardening check(s) failed:\n - ${failures.join("\n - ")}`); process.exit(1); }
console.log("PASS: mailbox sync gating, sensitive AI artifact/title isolation, portal link hardening, owner-only backup export, and complete contact merges.");
