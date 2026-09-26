import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

// Help articles (knowledge_articles): written through POST /api/platform-expansion (records.edit), shown to customers by
// GET /api/portal only when Published with audience Customers or Public.
const { sqlite, load } = createTestContext();
const owner = "owner@example.com", editor = "editor@example.com", viewer = "viewer@example.com";
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const platform = load("app/api/platform-expansion/route.ts"), portal = load("app/api/portal/route.ts");
const post = (email, body) => platform.POST(new Request("https://crm.example.com/api/platform-expansion", { method: "POST", headers: headers(email), body: JSON.stringify(body) }));
const get = email => platform.GET(new Request("https://crm.example.com/api/platform-expansion", { headers: headers(email) }));
async function expectStatus(promise, status, label) { const response = await promise, body = await response.clone().json().catch(() => ({})); assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`); return body; }
const row = id => sqlite.prepare("SELECT * FROM knowledge_articles WHERE id=?").get(id);
const auditCount = (action, id) => sqlite.prepare("SELECT count(*) AS n FROM audit_logs WHERE action=? AND entity_id=?").get(action, id).n;

sqlite.exec(`
INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('${editor}','Eddie','editor','{}','now','now'),('${viewer}','Vera','viewer','{}','now','now');
INSERT INTO companies(id,name,updated_at) VALUES (1,'Acme','now');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Casey','Client','casey@acme.test','Acme','now','now');
`);
const link = await expectStatus(post(owner, { action: "createPortalAccess", companyId: 1, contactId: 1, permissions: "knowledge" }), 201, "portal link");
const portalTitles = async () => { const response = await portal.GET(new Request("https://crm.example.com/api/portal", { headers: { "x-portal-token": link.token } })); assert.equal(response.status, 200); return (await response.json()).articles.map(item => item.title).sort(); };

// Create: defaults to Draft for Customers, slug from title, owner = author, audited.
const created = await expectStatus(post(editor, { action: "saveArticle", title: "Reset your password", category: "Account", body: "1. Open settings\n2. Choose Reset" }), 201, "create");
let article = row(created.id);
assert.deepEqual({ status: article.status, audience: article.audience, slug: article.slug, owner: article.owner, category: article.category, published_at: article.published_at }, { status: "Draft", audience: "Customers", slug: "reset-your-password", owner: editor, category: "Account", published_at: null });
assert.equal(auditCount("knowledge.save", created.id), 1, "create audited");
assert.deepEqual(await portalTitles(), [], "draft is not in the portal");

// Viewers can read the list but not write.
assert.ok((await expectStatus(get(viewer), 200, "viewer GET")).articles.some(item => item.id === created.id), "viewer sees articles in GET");
await expectStatus(post(viewer, { action: "saveArticle", title: "Nope", body: "x" }), 403, "viewer create");
await expectStatus(post(viewer, { action: "saveArticle", id: created.id, title: "Hijack", body: "x" }), 403, "viewer edit");
await expectStatus(post(viewer, { action: "setArticleStatus", id: created.id, status: "Published" }), 403, "viewer publish");
assert.equal(row(created.id).title, "Reset your password", "viewer changed nothing");

// Publish -> visible in the portal; published_at set.
await expectStatus(post(editor, { action: "setArticleStatus", id: created.id, status: "Published" }), 200, "publish");
article = row(created.id);
assert.equal(article.status, "Published");
assert.ok(article.published_at, "published_at set");
assert.equal(auditCount("knowledge.status", created.id), 1, "status change audited");
assert.deepEqual(await portalTitles(), ["Reset your password"], "published customer article in portal");

// Edit by id: same row, keeps slug and owner when not supplied, portal reflects the edit.
const edited = await expectStatus(post(owner, { action: "saveArticle", id: created.id, title: "Reset a forgotten password", category: "Account", audience: "Customers", status: "Published", body: "Updated steps" }), 201, "edit");
assert.equal(edited.id, created.id, "edit keeps id");
article = row(created.id);
assert.deepEqual({ title: article.title, body: article.body, slug: article.slug, owner: article.owner }, { title: "Reset a forgotten password", body: "Updated steps", slug: "reset-your-password", owner: editor });
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM knowledge_articles").get().n, 1, "edit did not insert a new row");
assert.deepEqual(await portalTitles(), ["Reset a forgotten password"], "portal reflects edit");
await expectStatus(post(editor, { action: "saveArticle", id: "missing-id", title: "Ghost", body: "x" }), 404, "edit unknown id");
await expectStatus(post(editor, { action: "setArticleStatus", id: "missing-id", status: "Archived" }), 404, "status unknown id");

// Unpublish -> Draft, gone from portal. Archive -> gone from portal, row kept.
await expectStatus(post(editor, { action: "setArticleStatus", id: created.id, status: "Draft" }), 200, "unpublish");
assert.deepEqual(await portalTitles(), [], "unpublished article hidden");
await expectStatus(post(editor, { action: "setArticleStatus", id: created.id, status: "Published" }), 200, "republish");
await expectStatus(post(editor, { action: "setArticleStatus", id: created.id, status: "Archived" }), 200, "archive");
assert.equal(row(created.id).status, "Archived", "archived row kept");
assert.deepEqual(await portalTitles(), [], "archived article hidden");

// Audience: Public shows in the portal, Internal never does even when published.
await expectStatus(post(editor, { action: "saveArticle", title: "Status page", audience: "Public", status: "Published", body: "See status.example.com" }), 201, "public article");
await expectStatus(post(editor, { action: "saveArticle", title: "Escalation runbook", audience: "Internal", status: "Published", body: "Page the on-call" }), 201, "internal article");
assert.deepEqual(await portalTitles(), ["Status page"], "only published Customers/Public articles in portal");

// Validation.
await expectStatus(post(editor, { action: "saveArticle", title: "Bad audience", audience: "Partners", body: "x" }), 400, "unknown audience");
await expectStatus(post(editor, { action: "saveArticle", title: "Bad status", status: "Live", body: "x" }), 400, "unknown status");
await expectStatus(post(editor, { action: "setArticleStatus", id: created.id, status: "Deleted" }), 400, "unknown status change");
await expectStatus(post(editor, { action: "saveArticle", title: "", body: "x" }), 400, "missing title");
await expectStatus(post(editor, { action: "saveArticle", title: "No body", body: "  " }), 400, "missing body");
await expectStatus(post(editor, { action: "saveArticle", title: "Huge", body: "x".repeat(24001) }), 400, "overlong body");
await expectStatus(post(editor, { action: "saveArticle", title: "t".repeat(201), body: "x" }), 400, "overlong title");
const duplicate = await expectStatus(post(editor, { action: "saveArticle", title: "Status page!", body: "Another" }), 400, "duplicate slug");
assert.match(duplicate.error, /status-page/, "duplicate slug error names the slug");
assert.doesNotMatch(duplicate.error, /UNIQUE|constraint/i, "duplicate slug error is friendly");
await expectStatus(post(editor, { action: "saveArticle", title: "Status page", slug: "status-page-2", body: "Another" }), 201, "explicit different slug ok");
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM knowledge_articles WHERE title LIKE 'Bad%' OR title='Huge'").get().n, 0, "rejected articles not saved");

console.log("PASS: help articles create/edit/publish/unpublish/archive, viewer is read-only, validation, and portal visibility.");
