import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const { sqlite, load } = createTestContext({ TRUST_PLATFORM_IDENTITY_HEADERS: "true", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", CRM_TOKEN_ENCRYPTION_KEY: key });
sqlite.exec("INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('owner@example.com','Olive','owner','{}','now','now'),('editor@example.com','Eddie','editor','{}','now','now'),('viewer@example.com','Vera','viewer','{}','now','now'),('other@example.com','Otto','editor','{}','now','now')");
const { encryptToken } = load("lib/microsoft.ts");
const enc = await encryptToken("secret-refresh");
const ins = (p, u) => sqlite.prepare("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'2099-01-01','now','now')").run(p, u, u || "co@x.com", "access-secret", enc).lastInsertRowid;
const edId = ins("microsoft", "editor@example.com"), otherId = ins("google", "other@example.com"); ins("quickbooks", "");
const h = email => ({ "content-type": "application/json", "oai-authenticated-user-id": `u-${email}`, "oai-authenticated-user-email": email });
const route = load("app/api/integrations/route.ts");
const get = async email => { const res = await route.GET(new Request("https://crm.example.com/api/integrations", { headers: h(email) })); return { res, text: await res.clone().text(), json: await res.json() }; };
const post = (email, body) => route.POST(new Request("https://crm.example.com/api/integrations", { method: "POST", headers: h(email), body: JSON.stringify(body) }));

const ed = await get("editor@example.com");
assert.deepEqual(ed.json.personal.mine.map(a => [a.id, a.provider, a.userName]), [[Number(edId), "microsoft", "Eddie"]]);
assert.equal(ed.json.personal.team, null);
const ow = await get("owner@example.com");
assert.equal(ow.json.personal.mine.length, 0);
assert.deepEqual(ow.json.personal.team.map(a => a.userEmail).sort(), ["editor@example.com", "other@example.com"]);
for (const r of [ed, ow]) assert.ok(!/access_token|refresh_token|access-secret/.test(r.text), "no tokens in response");
assert.equal(ow.json.personal.team[0].status, "connected");

assert.equal((await post("editor@example.com", { action: "disconnect", id: Number(otherId) })).status, 403);
assert.equal((await post("editor@example.com", { action: "savePreferences", id: Number(otherId), syncEmail: false })).status, 403);
assert.equal((await post("viewer@example.com", { action: "disconnect", id: Number(edId) })).status, 403);
assert.equal((await post("editor@example.com", { action: "disconnect", provider: "quickbooks" })).status, 403);
assert.equal((await post("editor@example.com", { action: "disconnect", id: 9999 })).status, 404);

assert.equal((await post("editor@example.com", { action: "savePreferences", id: Number(edId), syncEmail: false, syncCalendar: true, autoTasks: false })).status, 200);
const prefs = sqlite.prepare("SELECT sync_email,sync_calendar,auto_tasks FROM integration_accounts WHERE id=?").get(Number(edId));
assert.deepEqual([prefs.sync_email, prefs.sync_calendar, prefs.auto_tasks], [0, 1, 0]);
assert.ok(sqlite.prepare("SELECT 1 FROM audit_logs WHERE action='integration.preferences'").get());

// Owner disconnects another user's Google account: provider revoke is best-effort.
const fetched = []; const realFetch = globalThis.fetch; globalThis.fetch = async url => { fetched.push(String(url)); return new Response("{}", { status: 200 }); };
const res = await post("owner@example.com", { action: "disconnect", id: Number(otherId) });
globalThis.fetch = realFetch;
assert.equal(res.status, 200);
assert.equal(sqlite.prepare("SELECT count(*) c FROM integration_accounts").get().c, 2);
assert.ok(fetched.some(u => u.includes("google")), "google token revoked at provider");
const log = sqlite.prepare("SELECT actor_email,changes FROM audit_logs WHERE action='integration.disconnect'").get();
assert.equal(log.actor_email, "owner@example.com");
assert.deepEqual([JSON.parse(log.changes).provider, JSON.parse(log.changes).userEmail, JSON.parse(log.changes).by], ["google", "other@example.com", "owner@example.com"]);

// Editor disconnects own Microsoft account; QuickBooks still admin-only and keyed by provider.
assert.equal((await post("editor@example.com", { action: "disconnect", id: Number(edId) })).status, 200);
assert.equal(sqlite.prepare("SELECT count(*) c FROM integration_accounts").get().c, 1);
assert.equal((await post("owner@example.com", { action: "savePreferences", provider: "quickbooks", syncEmail: true })).status, 200);
globalThis.fetch = async () => new Response("{}", { status: 200 });
assert.equal((await post("owner@example.com", { action: "disconnect", provider: "quickbooks" })).status, 200);
globalThis.fetch = realFetch;
assert.equal(sqlite.prepare("SELECT count(*) c FROM integration_accounts").get().c, 0);
console.log("PASS: integrations API own and team connections");
