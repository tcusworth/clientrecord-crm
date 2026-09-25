import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const owner = "owner@example.com", admin = "admin@example.com", editor = "editor@example.com", editor2 = "editor2@example.com", viewer = "viewer@example.com";
const noSend = "nosend@example.com", noView = "noview@example.com", reviewer = "reviewer@example.com";
sqlite.exec(`
INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES
 ('${admin}','Ada','admin','{}','now','now'),('${editor}','Eddie','editor','{}','now','now'),('${editor2}','Edna','editor','{}','now','now'),('${viewer}','Vera','viewer','{}','now','now'),
 ('${noSend}','Nora','editor','["records.view","records.edit"]','now','now'),('${noView}','Ned','editor','["ai.view"]','now','now'),
 ('${reviewer}','Rita','editor','["records.view","ai.view","ai.review"]','now','now'),
 ('demoted@example.com','Dee','admin','["records.view","records.edit","records.delete","settings.manage"]','now','now');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Casey','Client','casey@acme.test','Acme','now','now'),(2,'Dana','Doe','dana@acme.test','Acme','now','now');
INSERT INTO deals(id,name,company,contact_id,stage,status,created_at,updated_at) VALUES (1,'Acme expansion','Acme',1,'Proposal','Open','now','now');
`);
const call = (route, path) => ({
  get: (email, query = "") => route.GET(new Request(`https://crm.example.com/api/${path}${query}`, { headers: headers(email) })),
  post: (email, body) => route.POST(new Request(`https://crm.example.com/api/${path}`, { method: "POST", headers: headers(email), body: JSON.stringify(body) })),
});
async function expectStatus(promise, status, label) { const response = await promise, body = await response.clone().json().catch(() => ({})); assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`); return body; }
const advanced = call(load("app/api/advanced/route.ts"), "advanced"), dealWorkspace = call(load("app/api/deal-workspace/route.ts"), "deal-workspace"), crm = call(load("app/api/crm/route.ts"), "crm");
const sales = call(load("app/api/sales/route.ts"), "sales"), quick = call(load("app/api/quick-capture/route.ts"), "quick-capture"), leads = call(load("app/api/lead-capture/route.ts"), "lead-capture"), inbox = call(load("app/api/inbox-capture/route.ts"), "inbox-capture");
const platform = call(load("app/api/platform-expansion/route.ts"), "platform-expansion"), governance = call(load("app/api/ai-governance/route.ts"), "ai-governance"), recordFields = call(load("app/api/ai-record-fields/route.ts"), "ai-record-fields");
const { crmUser, defaultPermissions } = load("lib/crm-auth.ts");

// 1. Changing a member's role resets stored custom permissions to the new role's defaults.
await expectStatus(advanced.post(owner, { action: "saveMember", email: "demoted@example.com", name: "Dee", role: "admin" }), 200, "same-role save");
assert.deepEqual((await crmUser(new Request("https://x", { headers: headers("demoted@example.com") }))).permissions, ["records.view", "records.edit", "records.delete", "settings.manage"], "re-saving the same role keeps custom permissions");
await expectStatus(advanced.post(owner, { action: "saveMember", email: "demoted@example.com", name: "Dee", role: "viewer" }), 200, "demote");
assert.deepEqual((await crmUser(new Request("https://x", { headers: headers("demoted@example.com") }))).permissions, defaultPermissions("viewer"), "demoted member gets viewer defaults");

// 2. Deal reviews need an approver other than the requester; requesters cannot decide their own review.
await expectStatus(dealWorkspace.post(editor, { action: "requestReview", dealId: 1, reviewType: "Pricing approval" }), 400, "missing approver");
await expectStatus(dealWorkspace.post(editor, { action: "requestReview", dealId: 1, approver: "EDITOR@example.com" }), 400, "self approver");
await expectStatus(dealWorkspace.post(editor, { action: "requestReview", dealId: 1, approver: owner }), 200, "valid request");
sqlite.exec(`INSERT INTO deal_reviews(id,deal_id,review_type,status,approver,requested_by,requested_at) VALUES (50,1,'Deal review','Requested','${editor}','${editor}','now'),(51,1,'Deal review','Requested','${editor}','${admin}','now'),(52,1,'Deal review','Requested','${owner}','${owner}','now')`);
await expectStatus(dealWorkspace.post(editor, { action: "decideReview", dealId: 1, id: 50, status: "Approved" }), 403, "requester deciding own legacy review");
await expectStatus(dealWorkspace.post(admin, { action: "decideReview", dealId: 1, id: 51, status: "Approved" }), 403, "admin requester deciding own review");
await expectStatus(dealWorkspace.post(owner, { action: "decideReview", dealId: 1, id: 52, status: "Approved" }), 200, "owner may decide own review");

// 3. Signed-in lead and inbox capture require records.edit.
await expectStatus(leads.post(viewer, { email: "lead@new.test", name: "New Lead" }), 403, "viewer lead capture");
await expectStatus(inbox.post(viewer, { fromEmail: "someone@new.test", subject: "Hi" }), 403, "viewer inbox capture");
await expectStatus(leads.post(editor, { email: "lead@new.test", name: "New Lead" }), 201, "editor lead capture");

// 4. Bulk/sequence email actions require campaigns.send.
await expectStatus(advanced.post(noSend, { action: "createSequence", name: "Blast", steps: [{ actionType: "email", subject: "Hi", body: "Hello" }] }), 403, "createSequence without campaigns.send");
await expectStatus(advanced.post(noSend, { action: "enrollSequence", sequenceId: 1, contactId: 1 }), 403, "enrollSequence without campaigns.send");
await expectStatus(advanced.post(noSend, { action: "runAutomations" }), 403, "runAutomations without campaigns.send");
await expectStatus(crm.post(noSend, { action: "syncCampaignAudience", id: 1 }), 403, "syncCampaignAudience without campaigns.send");
await expectStatus(advanced.post(editor, { action: "createSequence", name: "Nurture", steps: [{ actionType: "task", taskTitle: "Call" }] }), 201, "editor createSequence");

// 5. Proposal status allowlist; only owner/admin may mark Accepted.
await expectStatus(dealWorkspace.post(editor, { action: "saveProposal", dealId: 1, title: "Q", amount: 10, status: "Paid" }), 400, "unknown proposal status");
await expectStatus(dealWorkspace.post(editor, { action: "saveProposal", dealId: 1, title: "Q", amount: 10, status: "Accepted" }), 403, "editor accepted");
await expectStatus(dealWorkspace.post(editor, { action: "saveProposal", dealId: 1, title: "Q", amount: 10, status: "Sent" }), 200, "editor sent");
await expectStatus(dealWorkspace.post(admin, { action: "saveProposal", dealId: 1, title: "Q", amount: 10, status: "Accepted" }), 200, "admin accepted");

// 6. Recipient-originated suppressions can only be reversed by owner/admin.
sqlite.exec("INSERT INTO suppressions(email,reason,source,created_at) VALUES ('casey@acme.test','Recipient unsubscribe','Public page','now'),('dana@acme.test','bounced','Resend','now')");
await expectStatus(crm.post(editor, { action: "restoreContact", email: "casey@acme.test" }), 403, "editor restoring recipient unsubscribe");
await expectStatus(crm.post(editor, { action: "suppressContact", email: "dana@acme.test", reason: "Manual" }), 200, "editor re-suppress");
await expectStatus(crm.post(editor, { action: "restoreContact", email: "dana@acme.test" }), 403, "manual re-suppression does not launder a provider suppression");
await expectStatus(crm.post(admin, { action: "restoreContact", email: "casey@acme.test" }), 200, "admin restore");
await expectStatus(crm.post(editor, { action: "suppressContact", email: "casey@acme.test", reason: "Asked on call" }), 200, "manual suppress");
await expectStatus(crm.post(editor, { action: "restoreContact", email: "casey@acme.test" }), 200, "editor restores a manual suppression");

// 7. advanced setFieldValue validates like crm and checks the definition's entity.
sqlite.exec(`INSERT INTO custom_field_definitions(id,entity_type,name,field_key,field_type,options,created_at) VALUES (1,'contact','Tier','tier','select','["Gold","Silver"]','now'),(2,'contact','Seats','seats','number','[]','now')`);
await expectStatus(advanced.post(editor, { action: "setFieldValue", definitionId: 1, entityType: "contact", entityId: 1, value: "Platinum" }), 400, "invalid select option");
await expectStatus(advanced.post(editor, { action: "setFieldValue", definitionId: 2, entityType: "contact", entityId: 1, value: "lots" }), 400, "invalid number");
await expectStatus(advanced.post(editor, { action: "setFieldValue", definitionId: 1, entityType: "deal", entityId: 1, value: "Gold" }), 400, "entity mismatch");
await expectStatus(advanced.post(editor, { action: "setFieldValue", definitionId: 1, entityType: "contact", entityId: 1, value: "x".repeat(4001) }), 400, "too long");
await expectStatus(advanced.post(editor, { action: "setFieldValue", definitionId: 1, entityType: "contact", entityId: 1, value: "Gold" }), 200, "valid value");
assert.equal(sqlite.prepare("SELECT value FROM custom_field_values WHERE definition_id=1 AND entity_id=1").get().value, "Gold");

// 8. GET routes require records.view.
for (const [name, route, query] of [["crm", crm, ""], ["sales", sales, ""], ["advanced", advanced, ""], ["deal-workspace", dealWorkspace, "?dealId=1"], ["quick-capture", quick, "?name=Casey"]]) {
  await expectStatus(route.get(noView, query), 403, `${name} GET without records.view`);
  assert.equal((await route.get(viewer, query)).status, 200, `${name} GET for viewer`);
}

// 9. AI: Edited only for editable features; applying record fields needs records.edit.
sqlite.exec(`INSERT INTO ai_runs(id,feature,entity_type,entity_id,status,provider,model,prompt_version,input_hash,requested_by,source_count,started_at) VALUES ('run-9','account-summary','company','1','Completed','openai','m',1,'h','${owner}',1,'now');
INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,input_hash,generated_by,generated_at) VALUES
 ('summary-1','run-9','account-summary','company','1','{"summary":"Original"}','{"summary":"Original"}','x',80,'openai','m',1,'h','${owner}','now'),
 ('followup-1','run-9','follow-up-draft','deal','1','{"summary":"Original"}','{"summary":"Original"}','x',80,'openai','m',1,'h','${owner}','now'),
 ('fields-1','run-9','record-fields-contact','contact','1','{}','{}','x',80,'openai','m',1,'h','${owner}','now');`);
await expectStatus(governance.post(editor, { action: "reviewArtifact", id: "summary-1", status: "Edited", contentJson: '{"summary":"Injected"}' }), 400, "Edited on non-editable feature");
assert.equal(sqlite.prepare("SELECT content_json AS c FROM ai_artifacts WHERE id='summary-1'").get().c, '{"summary":"Original"}');
await expectStatus(governance.post(viewer, { action: "reviewArtifact", id: "followup-1", status: "Edited", contentJson: "{}" }), 403, "viewer edit");
await expectStatus(governance.post(editor, { action: "reviewArtifact", id: "followup-1", status: "Edited", contentJson: '{"summary":"Edited"}' }), 200, "Edited on follow-up draft");
await expectStatus(recordFields.post(reviewer, { action: "review", entityType: "contact", entityId: 1, artifactId: "fields-1", status: "Accepted" }), 403, "accept record fields without records.edit");
await expectStatus(recordFields.post(reviewer, { action: "review", entityType: "contact", entityId: 1, artifactId: "fields-1", status: "Rejected" }), 200, "reject record fields with ai.review only");

// 10. Field capture upserts cannot overwrite another user's capture.
await expectStatus(platform.post(editor, { action: "saveFieldCapture", id: "cap-1", note: "Mine" }), 201, "first capture");
await expectStatus(platform.post(editor2, { action: "saveFieldCapture", id: "cap-1", note: "Overwritten" }), 403, "other user overwrite");
assert.equal(sqlite.prepare("SELECT note FROM field_captures WHERE id='cap-1'").get().note, "Mine");
await expectStatus(platform.post(editor, { action: "saveFieldCapture", id: "cap-1", note: "Mine v2" }), 201, "owner update");
assert.equal(sqlite.prepare("SELECT note,captured_by AS by FROM field_captures WHERE id='cap-1'").get().note, "Mine v2");

// 11. Length caps.
await expectStatus(crm.post(editor, { action: "createContact", firstName: "Long", lastName: "Notes", email: "long@x.test", notes: "n".repeat(20001) }), 400, "notes cap");
await expectStatus(crm.post(editor, { action: "saveCampaign", name: "C", subject: "s".repeat(501), html: "<p>x</p>" }), 400, "subject cap");
await expectStatus(crm.post(editor, { action: "saveCampaign", name: "C", subject: "Hi", html: "h".repeat(500001) }), 400, "html cap");
await expectStatus(crm.post(editor, { action: "saveCampaign", name: "C", subject: "Hi", html: "<p>ok</p>" }), 201, "normal campaign");
await expectStatus(quick.post(editor, { action: "commitProposals", proposals: Array.from({ length: 51 }, () => ({ type: "activity", payload: { contactId: 1, note: "x" } })) }), 400, "proposal cap");
await expectStatus(leads.post(editor, { email: "big@new.test", attribution: { blob: "a".repeat(20001) } }), 400, "attribution cap");
await expectStatus(leads.post(editor, { email: "big@new.test", payload: { blob: "a".repeat(20001) } }), 400, "payload cap");

// 12. LIKE wildcards in quick-capture duplicate search are literal.
for (const name of ["%", "_", "%_%"]) assert.equal((await (await quick.get(editor, `?name=${encodeURIComponent(name)}`)).json()).matches.length, 0, `wildcard ${name} matches nothing`);
assert.equal((await (await quick.get(editor, "?name=Casey")).json()).matches.length, 1, "normal search still works");

console.log("PASS: role-change permission reset, review separation, capture/campaign/proposal/suppression permissions, custom field validation, records.view GETs, AI edit scope, field-capture ownership, length caps, and LIKE escaping.");
