import assert from "node:assert/strict";
import fs from "node:fs";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext({ CRM_TOKEN_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"), QUICKBOOKS_CLIENT_ID: "qb-client", QUICKBOOKS_CLIENT_SECRET: "qb-secret", RESEND_WEBHOOK_SECRET: `whsec_${btoa("resend-signing-secret")}` });
const auth = load("lib/crm-auth.ts"), { encryptToken } = load("lib/microsoft.ts");
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const owner = "owner@example.com";
const realFetch = globalThis.fetch;
let fetchCalls = [], fetchImpl = async () => new Response("ok");
globalThis.fetch = async (url, init = {}) => { fetchCalls.push({ url: String(url), init }); return fetchImpl(String(url), init); };
async function apiKey(scopes) { const raw = `cr_live_${crypto.randomUUID()}`; sqlite.prepare("INSERT INTO api_keys(id,name,key_hash,key_prefix,scopes,created_by,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run(crypto.randomUUID(), "test", await auth.sha256(raw), raw.slice(0, 16), scopes, owner); return raw; }
function member(email, role, permissions) { sqlite.prepare("INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES (?,?,?,?,'now','now')").run(email, email, role, JSON.stringify(permissions)); }

try {
  // 1. Operations: backups.manage / webhooks.manage are enforced; GET needs records.view.
  const operations = load("app/api/operations/route.ts");
  member("settings@example.com", "admin", ["records.view", "settings.manage"]);
  member("backups@example.com", "viewer", ["records.view", "backups.manage"]);
  member("hooks@example.com", "viewer", ["records.view", "webhooks.manage"]);
  member("noview@example.com", "viewer", ["ai.view"]);
  member("viewer@example.com", "viewer", ["records.view", "documents.view", "ai.view"]);
  const op = async (email, body) => { const response = await operations.POST(new Request("https://crm.example.com/api/operations", { method: "POST", headers: headers(email), body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
  assert.equal((await op("settings@example.com", { action: "restoreBackup", id: "x" })).status, 403, "settings.manage alone cannot restore backups");
  assert.equal((await op("settings@example.com", { action: "createBackup" })).status, 403, "settings.manage alone cannot create backups");
  assert.equal((await op("settings@example.com", { action: "saveWebhook", url: "https://hooks.example.com/x" })).status, 403, "settings.manage alone cannot save webhooks");
  assert.equal((await op("settings@example.com", { action: "disableWebhook", id: "x" })).status, 403);
  assert.equal((await op("settings@example.com", { action: "testWebhooks" })).status, 403);
  assert.equal((await op("settings@example.com", { action: "createApiKey", scopes: "records.read" })).status, 201, "settings.manage still manages API keys");
  assert.equal((await op("backups@example.com", { action: "restoreBackup", id: "x" })).status, 400, "backups.manage reaches the confirmation check");
  assert.equal((await op("backups@example.com", { action: "createApiKey", scopes: "records.read" })).status, 403, "backups.manage is not settings.manage");
  assert.equal((await op("hooks@example.com", { action: "saveWebhook", url: "http://hooks.example.com/x" })).status, 400, "webhooks.manage reaches URL validation");
  assert.equal((await op("hooks@example.com", { action: "restoreBackup", id: "x" })).status, 403);
  const get = email => operations.GET(new Request("https://crm.example.com/api/operations", { headers: headers(email) }));
  assert.equal((await get("noview@example.com")).status, 403, "operations GET requires records.view");
  const viewerOps = await get("viewer@example.com"); assert.equal(viewerOps.status, 200); assert.equal((await viewerOps.json()).operations, null, "viewers never see the operations console");

  // 2. Outbound webhook URL validation, at save time and at delivery time.
  const webhooks = load("lib/webhooks.ts");
  for (const bad of ["http://hooks.example.com/x", "https://user:pass@hooks.example.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://0x7f.1/x", "https://2130706433/x", "https://localhost/x", "https://localhost./x", "https://api.localhost/x", "https://printer.local/x", "https://metadata.google.internal/x", "https://hooks.example.com:8443/x", "https://intranet/x", "not a url"])
    assert.equal(webhooks.safeWebhookUrl(bad), null, `${bad} is rejected`);
  for (const good of ["https://hooks.example.com/x", "https://hooks.example.com:443/x?a=1"]) assert.ok(webhooks.safeWebhookUrl(good), `${good} is accepted`);
  for (const bad of ["https://10.1.2.3/hook", "https://a:b@hooks.example.com/", "https://hooks.example.com:444/"]) assert.equal((await op(owner, { action: "saveWebhook", url: bad })).status, 400, `saveWebhook rejects ${bad}`);
  const saved = await op(owner, { action: "saveWebhook", url: "https://hooks.example.com/ok", events: "webhook.test" }); assert.equal(saved.status, 201, JSON.stringify(saved.body));
  sqlite.prepare("INSERT INTO webhook_endpoints(id,name,url,events,secret_encrypted,active,created_at) VALUES ('legacy','Legacy','https://10.0.0.1/hook','webhook.test',?,1,'now')").run(await encryptToken("whsec_legacy"));
  fetchCalls = []; fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } });
  await webhooks.emitWebhook("webhook.test", { ok: true });
  assert.equal(fetchCalls.length, 1, "unsafe stored endpoints are never requested");
  assert.equal(fetchCalls[0].url, "https://hooks.example.com/ok");
  assert.equal(fetchCalls[0].init.redirect, "manual", "redirects are not followed");
  assert.ok(fetchCalls[0].init.signal instanceof AbortSignal, "deliveries carry a timeout signal");
  const deliveries = sqlite.prepare("SELECT endpoint_id AS endpointId,status,response_status AS responseStatus,error FROM webhook_deliveries ORDER BY id").all();
  assert.deepEqual(deliveries.map(row => [row.endpointId, row.status]).sort(), [[saved.body.id, "Failed"], ["legacy", "Failed"]].sort(), "3xx and blocked URLs are recorded as failures");
  assert.match(deliveries.find(row => row.endpointId === "legacy").error, /not allowed/i);
  fetchImpl = async () => { throw new Error("network down"); };
  await webhooks.emitWebhook("webhook.test", {});
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM webhook_deliveries WHERE error LIKE '%network down%'").get().count, 1, "failed deliveries are still recorded");
  const prepare = env.DB.prepare, logError = console.error; let logged = 0; env.DB.prepare = () => { throw new Error("D1 unavailable"); }; console.error = () => { logged++; };
  try { await webhooks.emitWebhook("webhook.test", {}); } finally { env.DB.prepare = prepare; console.error = logError; }
  assert.equal(logged, 1, "dispatch failures are logged, not thrown");
  fetchImpl = async () => new Response("ok");
  await auth.audit({ email: owner }, "webhook.test", "test", 1, "audit still works with webhooks configured");

  // 3. Company enrichment never requests non-default ports.
  const enrichment = load("lib/company-enrichment.ts");
  fetchCalls = []; await assert.rejects(enrichment.enrichCompanyWebsite("acme-industrial.com", "https://acme-industrial.com:8080/"), /not safe/);
  assert.equal(fetchCalls.length, 0, "explicit non-default port is rejected before fetching");
  fetchImpl = async () => new Response(null, { status: 301, headers: { location: "https://acme-industrial.com:6379/" } });
  await assert.rejects(enrichment.enrichCompanyWebsite("acme-industrial.com", "https://acme-industrial.com/"), /not safe/);
  assert.equal(fetchCalls.length, 1, "redirect to a non-default port is not followed");
  fetchImpl = async () => new Response("<html><title>Acme</title></html>", { headers: { "content-type": "text/html" } });
  assert.equal((await enrichment.enrichCompanyWebsite("acme-industrial.com", "https://acme-industrial.com:443/")).domain, "acme-industrial.com", "explicit default port is fine");

  // 4. /api/v1/records: own-property type lookup and input validation.
  const records = load("app/api/v1/records/route.ts"), readKey = await apiKey("records.read"), writeKey = await apiKey("records.write");
  const v1 = (method, type, key, body) => records[method](new Request(`https://crm.example.com/api/v1/records?type=${type}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", "bogus"]) {
    assert.equal((await v1("GET", type, readKey)).status, 400, `GET type=${type}`);
    assert.equal((await v1("POST", type, writeKey, { email: "a@b.co" })).status, 400, `POST type=${type}`);
  }
  assert.equal((await v1("GET", "contacts", readKey)).status, 200);
  for (const body of [{ email: "not-an-email" }, { email: "a@b" }, { email: `${"a".repeat(400)}@example.com` }, { email: "ok@example.com", firstName: "x".repeat(1000) }, { email: "ok@example.com", notes: "x".repeat(25000) }, { email: "ok@example.com", stage: "x".repeat(200) }, { email: "ok@example.com", tags: Array.from({ length: 200 }, (_, i) => `t${i}`) }])
    assert.equal((await v1("POST", "contacts", writeKey, body)).status, 400, `rejects ${JSON.stringify(body).slice(0, 60)}`);
  assert.equal((await v1("POST", "companies", writeKey, { name: "Acme", owner: "x".repeat(500) })).status, 400, "owner is capped");
  assert.equal((await v1("POST", "deals", writeKey, { name: "Deal", stage: "y".repeat(200) })).status, 400, "deal stage is capped");
  const created = await v1("POST", "contacts", writeKey, { email: "Valid.Person@Example.com", firstName: "Val", tags: ["api"] });
  assert.equal(created.status, 201);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM contacts WHERE email='valid.person@example.com'").get().count, 1);
  const malformed = await records.POST(new Request("https://crm.example.com/api/v1/records?type=contacts", { method: "POST", headers: { authorization: `Bearer ${writeKey}` }, body: "{" }));
  assert.equal(malformed.status, 400, "malformed JSON is a 400");

  // 5. QuickBooks connect stores the account with its realmId; realmId must be digits.
  const qbCallback = load("app/api/quickbooks/callback/route.ts");
  const state = s => sqlite.prepare("INSERT INTO oauth_states(state,actor_email,expires_at,created_at) VALUES (?,?,datetime('now','+10 minutes'),datetime('now'))").run(s, owner);
  fetchCalls = []; fetchImpl = async url => url.includes("oauth.platform.intuit.com") ? Response.json({ access_token: "qb-access", refresh_token: "qb-refresh", expires_in: 3600 }) : url.includes("/companyinfo/") ? Response.json({ CompanyInfo: { CompanyName: "Acme Books" } }) : new Response("unexpected", { status: 500 });
  state("qb-bad");
  let redirect = await qbCallback.GET(new Request("https://crm.example.com/api/quickbooks/callback?state=qb-bad&code=c&realmId=123%2F..%2Fx"));
  assert.match(redirect.headers.get("location"), /quickbooks_error/, "non-numeric realmId is rejected");
  assert.equal(fetchCalls.length, 0, "no token exchange for an invalid realmId");
  state("qb-ok");
  redirect = await qbCallback.GET(new Request("https://crm.example.com/api/quickbooks/callback?state=qb-ok&code=c&realmId=9130357"));
  assert.match(redirect.headers.get("location"), /quickbooks_connected/, "QuickBooks connect succeeds");
  const qbRow = sqlite.prepare("SELECT account_email AS name,metadata_json AS metadata,sync_email AS syncEmail FROM integration_accounts WHERE provider='quickbooks'").get();
  assert.equal(qbRow.name, "Acme Books"); assert.deepEqual(JSON.parse(qbRow.metadata), { realmId: "9130357", companyName: "Acme Books" }); assert.equal(qbRow.syncEmail, 0);

  // 6. Meetily: >50 attendees stays under D1's 100 bound parameters; body size is checked before parsing.
  const meetily = load("app/api/integrations/meetily/meetings/route.ts"), meetKey = await apiKey("meetings.import");
  const d1Prepare = env.DB.prepare;
  env.DB.prepare = sql => { const statement = d1Prepare.call(env.DB, sql), bind = statement.bind; statement.bind = (...args) => { if (args.length > 100) throw new Error("D1_ERROR: too many SQL variables"); return bind.apply(statement, args); }; return statement; };
  const meetingPost = body => meetily.POST(new Request("https://crm.example.com/api/integrations/meetily/meetings", { method: "POST", headers: { authorization: `Bearer ${meetKey}`, "content-type": "application/json" }, body }));
  try {
    const attendees = Array.from({ length: 80 }, (_, i) => ({ name: `Person ${i}`, email: `person${i}@bigco.test` }));
    const response = await meetingPost(JSON.stringify({ meeting: { id: "big-meeting", title: "All hands", attendees, summary: "Summary" } }));
    assert.equal(response.status, 202, `large attendee list imports (${JSON.stringify(await response.clone().json())})`);
    assert.equal((await response.json()).status, "Needs association");
  } finally { env.DB.prepare = d1Prepare; }
  const huge = JSON.stringify({ meeting: { id: "huge", transcript: "x".repeat(1_600_000) } });
  const tooBig = await meetingPost(huge); assert.equal(tooBig.status, 413, "oversized payloads are rejected with 413");
  let parsed = false; const realParse = JSON.parse; JSON.parse = (...args) => { if (typeof args[0] === "string" && args[0].length > 1_500_000) parsed = true; return realParse(...args); };
  try { await meetingPost(huge); } finally { JSON.parse = realParse; }
  assert.equal(parsed, false, "oversized payloads are never parsed");
  assert.equal((await meetingPost("{not json")).status, 400);

  // 7. Resend/Svix signatures verify via the constant-time comparison helper.
  const resend = load("lib/resend.ts");
  const svix = async (payload, id, timestamp) => { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("resend-signing-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`))))); };
  const ts = String(Math.floor(Date.now() / 1000)), sig = await svix("{}", "msg_1", ts);
  const svixHeaders = signature => new Headers({ "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": signature });
  assert.equal(await resend.verifyResendWebhook("{}", svixHeaders(`v1,bogus v1,${sig}`)), true, "any matching v1 signature verifies");
  assert.equal(await resend.verifyResendWebhook("{}", svixHeaders(`v1,${sig.slice(0, -2)}AA`)), false);
  assert.equal(await resend.verifyResendWebhook("{\"x\":1}", svixHeaders(`v1,${sig}`)), false);
  assert.equal(await resend.verifyResendWebhook("{}", svixHeaders(`v2,${sig}`)), false);
  assert.doesNotMatch(fs.readFileSync(new URL("../lib/resend.ts", import.meta.url), "utf8"), /part\s*===\s*`v1/, "signature is not compared with ===");

  // 8. AI workspace live query escapes LIKE wildcards.
  sqlite.exec("INSERT INTO deals(name,company,stage,status,created_at,updated_at) VALUES ('Zzqab renewal','Zzqab','Proposal','Open','now','now'),('Zzq_% literal','Other','Proposal','Open','now','now')");
  const workspace = load("app/api/ai-workspace/route.ts");
  const analyze = async question => { const response = await workspace.POST(new Request("https://crm.example.com/api/ai-workspace", { method: "POST", headers: headers(owner), body: JSON.stringify({ action: "analyzeCRM", question, force: true }) })); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.artifact.content.records.map(row => row.name); };
  assert.deepEqual(await analyze("zzq_%"), ["Zzq_% literal"], "% and _ are matched literally");
  assert.deepEqual((await analyze("zzqab")).sort(), ["Zzqab renewal"]);

  console.log("PASS: operations permissions, webhook URL/delivery hardening, enrichment ports, v1 records validation, QuickBooks connect, Meetily limits, Svix signature compare, and LIKE escaping.");
} finally { globalThis.fetch = realFetch; }
