import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
const deals = load("lib/services/deals.ts");
const fresh = await deals.mainPipeline(env.DB);
assert.equal(fresh.id, "default", "fresh install falls back to the built-in pipeline");
assert.deepEqual((await deals.pipelines(env.DB)).map(p => p.id), ["default"]);

const stages = JSON.stringify([{ key: "target", name: "Target", probability: 10, kind: "Open" }, { key: "won", name: "Won", probability: 100, kind: "Won" }, { key: "lost", name: "Lost", probability: 0, kind: "Lost" }]);
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES ('csi','CSI pipeline',?, 'now')").run(stages);
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES ('aaa','AAA later',?, 'now')").run(stages);
assert.equal((await deals.mainPipeline(env.DB)).id, "csi", "first saved by rowid, not by name");
assert.deepEqual((await deals.pipelines(env.DB)).map(p => p.id), ["csi", "aaa"], "built-in no longer prepended once pipelines are saved");

const owner = "owner@example.com", user = { id: "u1", email: owner, role: "owner", permissions: [] };
const deal = id => sqlite.prepare("SELECT * FROM deals WHERE id=?").get(id);

// A legacy deal still on the built-in pipeline stays saveable after the built-in pipeline stops being listed.
const legacy = await deals.saveDeal(env.DB, { name: "Test", owner, pipeline_key: "default", stage_key: "Qualified", next_step: "Call" }, owner);
await deals.saveDeal(env.DB, { id: legacy.id, name: "Test renamed", owner, pipeline_key: "default", stage_key: "Discovery", next_step: "Call" }, owner);
assert.equal(deal(legacy.id).pipeline_key, "default");
assert.equal(deal(legacy.id).stage_key, "Discovery");

// Customer success renewal lands in the main pipeline at its first Open stage.
sqlite.prepare("INSERT INTO companies(id,name,owner,updated_at) VALUES (1,'Acme','owner@example.com','now')").run();
const cs = load("lib/customer-success.ts");
const plan = await cs.saveCustomerSuccessPlan({ companyId: 1, renewalDate: "2026-12-01", annualValue: 5000 }, user);
const renewal = await cs.createRenewalDeal(plan.id, user);
const renewed = deal(renewal.dealId);
assert.equal(renewed.pipeline_key, "csi");
assert.equal(renewed.stage_key, "target");
assert.equal(renewed.stage, "Target");
assert.equal(renewed.probability, 10);
assert.equal(renewed.name, "Acme renewal");
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sales_pipelines WHERE id='renewals'").get().n, 0, "no separate renewals pipeline is created");
const csRoute = load("app/api/customer-success/route.ts");
const csPayload = await (await csRoute.GET(new Request("https://crm.example.com/api/customer-success", { headers: { "oai-authenticated-user-id": `user-${owner}`, "oai-authenticated-user-email": owner } }))).json();
assert.ok(csPayload.renewalDeals.some(d => d.id === renewal.dealId), "the renewal deal shows in the Customer success renewal pipeline");

// v1 records API: a deal without a pipeline joins the main pipeline at its first Open stage.
const auth = load("lib/crm-auth.ts");
const raw = `cr_live_${crypto.randomUUID()}`;
sqlite.prepare("INSERT INTO api_keys(id,name,key_hash,key_prefix,scopes,created_by,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run(crypto.randomUUID(), "test", await auth.sha256(raw), raw.slice(0, 16), "records.write", owner);
const records = load("app/api/v1/records/route.ts");
const v1 = body => records.POST(new Request("https://crm.example.com/api/v1/records?type=deals", { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
let response = await v1({ name: "API deal" });
assert.equal(response.status, 201);
const apiDeal = deal(Number((await response.json()).id));
assert.equal(apiDeal.pipeline_key, "csi");
assert.equal(apiDeal.stage_key, "target");
assert.equal(apiDeal.stage, "Target");
response = await v1({ name: "API deal elsewhere", pipelineKey: "aaa", stage: "Won" });
assert.equal(response.status, 201);
assert.equal(deal(Number((await response.json()).id)).pipeline_key, "aaa", "an explicit pipeline is kept");

// Quick capture: a deal draft lands in the main pipeline at its first stage.
const quick = load("app/api/quick-capture/route.ts");
const headers = { "oai-authenticated-user-id": `user-${owner}`, "oai-authenticated-user-email": owner, "content-type": "application/json" };
response = await quick.POST(new Request("https://crm.example.com/api/quick-capture", { method: "POST", headers, body: JSON.stringify({ action: "commitDraft", draft: { kind: "deal", name: "Quick deal" } }) }));
assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
const quickDeal = deal(Number((await response.json()).id));
assert.equal(quickDeal.pipeline_key, "csi");
assert.equal(quickDeal.stage_key, "target");

// GET /api/sales names the main pipeline.
const sales = load("app/api/sales/route.ts");
const payload = await (await sales.GET(new Request("https://crm.example.com/api/sales", { headers }))).json();
assert.equal(payload.mainPipelineId, "csi");

// Free-text company with no linked record survives a save (e.g. a board drag); a linked company still wins.
const textOnly = await deals.saveDeal(env.DB, { name: "Text company deal", owner, pipeline_key: "csi", stage_key: "target", next_step: "Call", company: "Globex" }, owner);
assert.equal(deal(textOnly.id).company, "Globex");
assert.equal(deal(textOnly.id).company_id, null);
await deals.saveDeal(env.DB, { id: textOnly.id, name: "Text company deal", owner, pipeline_key: "csi", stage_key: "target", next_step: "Call again", company: "Globex", company_id: null }, owner);
assert.equal(deal(textOnly.id).company, "Globex", "re-saving keeps the company text");
await deals.saveDeal(env.DB, { id: textOnly.id, name: "Text company deal", owner, pipeline_key: "csi", stage_key: "target", next_step: "Call", company: "Globex", company_id: 1 }, owner);
assert.equal(deal(textOnly.id).company, "Acme", "a linked company record sets the name");
assert.equal(deal(textOnly.id).company_id, 1);

// Deals drawer: the form always sends contact_id, so saving a deal keeps its primary contact.
sqlite.prepare("INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (7,'Pat','Lee','pat@acme.test','Acme','now','now')").run();
const withContact = await deals.saveDeal(env.DB, { name: "Contact deal", owner, pipeline_key: "csi", stage_key: "target", next_step: "Call", company_id: 1, contact_id: 7 }, owner);
assert.equal(deal(withContact.id).contact_id, 7);
const form = load("lib/deal-form.ts");
const drawerEntries = { name: "Contact deal", company_id: "1", owner, stage_key: "target", value: "0", close_date: "", next_step: "Call again", forecast_category: "Pipeline", lead_source: "Direct", partner: "", campaign: "" };
const drawerPayload = form.dealFormPayload({ id: withContact.id, company: "Acme", company_id: 1 }, drawerEntries, "csi", "7");
assert.equal(drawerPayload.contact_id, "7", "the drawer form sends the selected primary contact");
assert.equal(form.dealFormPayload({ id: withContact.id, company: "Acme", company_id: 1 }, drawerEntries, "csi", "").contact_id, "", "an empty selection is still sent (none)");
const saveDealRoute = body => sales.POST(new Request("https://crm.example.com/api/sales", { method: "POST", headers, body: JSON.stringify({ action: "saveDeal", ...body }) }));
response = await saveDealRoute(drawerPayload);
assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
assert.equal(deal(withContact.id).contact_id, 7, "a drawer save keeps the primary contact");
assert.equal(deal(withContact.id).next_step, "Call again");
response = await saveDealRoute({ id: withContact.id, ...drawerEntries, pipeline_key: "csi" });
assert.equal(deal(withContact.id).contact_id, null, "the old payload without contact_id cleared the contact, which is why the form must send it");

console.log("PASS: main pipeline rule");
