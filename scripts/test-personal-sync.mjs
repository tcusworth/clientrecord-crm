// Task 3: per-account Microsoft/Google sync and "Sync now" for your own account. All provider calls are stubbed.
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const past = (days) => new Date(Date.now() - days * 86400000).toISOString();
const headers = (email) => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email });

for (const provider of ["microsoft", "google"]) {
  const { sqlite, load } = createTestContext({ MS_CLIENT_ID: "ms-id", MS_CLIENT_SECRET: "ms-secret", GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret", CRM_TOKEN_ENCRYPTION_KEY: key });
  sqlite.exec(`INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('editor@example.com','Eddie','editor','{}','now','now'),('other@example.com','Otto','editor','{}','now','now'),('lonely@example.com','Lou','editor','{}','now','now'),('viewer@example.com','Vera','viewer','{}','now','now'),('gone@example.com','Gus','editor','{}','now','now');
UPDATE team_members SET active=0 WHERE email='gone@example.com';
INSERT INTO companies(id,name,updated_at) VALUES (1,'Acme Industries','2026-01-01');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Casey','Champion','client@acme.test','Acme Industries','2026-01-01','2026-01-01');
INSERT INTO deals(id,name,company,company_id,contact_id,stage,stage_key,pipeline_key,owner,status,created_at,updated_at) VALUES (1,'Acme expansion','Acme Industries',1,1,'Proposal','proposal','default','owner@example.com','Open','2026-01-01','2026-01-01');`);
  const { encryptToken } = load("lib/microsoft.ts");
  const accounts = load("lib/integrations/accounts.ts");
  const lib = load(`lib/integrations/${provider}-sync.ts`);
  const sync = provider === "microsoft" ? lib.syncMicrosoftAccount : lib.syncGoogleAccount;
  const addAccount = async (userEmail, expiresAt = "2099-01-01T00:00:00Z") => {
    sqlite.prepare("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'now','now')").run(provider, userEmail, "box@corp.com", await encryptToken("acc"), await encryptToken("ref"), expiresAt);
    return accounts.ownAccount(provider, userEmail);
  };

  // Canned provider responses: one email from a seeded contact, one from an unknown sender, one meeting with the contact.
  let tokenReply = () => Response.json({ access_token: "fresh", expires_in: 3600 });
  let apiStatus = 200;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes("/oauth2/v2.0/token") || u === "https://oauth2.googleapis.com/token") return tokenReply();
    if (apiStatus !== 200) return Response.json({ error: { message: "Unauthorized" } }, { status: apiStatus });
    if (u.startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ mail: "box@corp.com" });
    if (u.startsWith("https://graph.microsoft.com/v1.0/me/messages?")) return Response.json({ value: [
      { id: "m1", conversationId: "c1", subject: "Pricing question", bodyPreview: "Can you send pricing?", from: { emailAddress: { address: "Client@Acme.test" } }, toRecipients: [{ emailAddress: { address: "box@corp.com" } }], receivedDateTime: past(1), hasAttachments: false },
      { id: "m2", conversationId: "c2", subject: "Hello there", bodyPreview: "Intro", from: { emailAddress: { address: "stranger@unknown.test" } }, toRecipients: [{ emailAddress: { address: "box@corp.com" } }], receivedDateTime: past(1), hasAttachments: false },
    ] });
    if (u.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?")) return Response.json({ value: [
      { id: "e1", subject: "Discovery call", start: { dateTime: past(2) }, end: { dateTime: past(2) }, organizer: { emailAddress: { address: "box@corp.com" } }, attendees: [{ emailAddress: { address: "client@acme.test" } }] },
    ] });
    if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({ messages: [{ id: "g1" }, { id: "g2" }] });
    if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/g1?")) return Response.json({ id: "g1", threadId: "t1", internalDate: String(Date.now() - 86400000), payload: { headers: [{ name: "From", value: "Casey <client@acme.test>" }, { name: "To", value: "box@corp.com" }, { name: "Subject", value: "Pricing question" }] } });
    if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/g2?")) return Response.json({ id: "g2", threadId: "t2", internalDate: String(Date.now() - 86400000), payload: { headers: [{ name: "From", value: "stranger@unknown.test" }, { name: "To", value: "box@corp.com" }, { name: "Subject", value: "Hello there" }] } });
    if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) return Response.json({ items: [
      { id: "ge1", summary: "Discovery call", start: { dateTime: past(2) }, end: { dateTime: past(2) }, organizer: { email: "box@corp.com" }, attendees: [{ email: "client@acme.test" }] },
    ] });
    throw new Error(`Unexpected fetch ${u}`);
  };
  const [emailId, unknownId, eventId] = provider === "microsoft" ? ["m1", "m2", "e1"] : ["g1", "g2", "ge1"];
  const source = provider === "microsoft" ? "Microsoft" : "Google";
  const count = (table) => sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

  // 1. First account: rows are owned by the mailbox owner and tagged with the account.
  const a = await addAccount("editor@example.com");
  const first = await sync(a);
  assert.equal(first.accountId, a.id);
  assert.equal(first.emails, 1, `${provider}: one matched email`); assert.equal(first.events, 1, `${provider}: one meeting`); assert.equal(first.reviewQueued, 1, `${provider}: unknown sender queued`); assert.equal(first.skipped, 0);
  const inbox = sqlite.prepare("SELECT * FROM inbox_messages WHERE external_id=?").get(emailId);
  assert.equal(inbox.owner, "editor@example.com"); assert.equal(inbox.account_id, a.id); assert.equal(inbox.direction, "Inbound"); assert.equal(inbox.contact_id, 1); assert.equal(inbox.deal_id, 1);
  assert.deepEqual(sqlite.prepare("SELECT external_id,account_id FROM sync_records ORDER BY external_id").all().map(r => ({ ...r })), [{ external_id: eventId, account_id: a.id }, { external_id: emailId, account_id: a.id }].sort((x, y) => x.external_id.localeCompare(y.external_id)));
  assert.deepEqual(sqlite.prepare("SELECT type FROM activities WHERE contact_id=1 ORDER BY type").all().map(r => r.type), ["Calendar meeting", "Email received"]);
  assert.deepEqual(sqlite.prepare("SELECT type,owner,source FROM deal_activities ORDER BY type").all().map(r => ({ ...r })), [{ type: "Email received", owner: "editor@example.com", source }, { type: "Meeting", owner: "editor@example.com", source }]);
  const review = sqlite.prepare("SELECT * FROM communication_review_items").all();
  assert.equal(review.length, 1); assert.equal(review[0].source, source); assert.equal(review[0].source_id, unknownId); assert.equal(review[0].kind, "Unknown contact"); assert.equal(review[0].sender_email, "stranger@unknown.test"); assert.equal(review[0].status, "Pending");
  assert.equal(JSON.parse(review[0].suggested_contact_json).companyDomain, "unknown.test");
  const afterA = await accounts.accountById(a.id);
  assert.ok(afterA.last_synced_at, `${provider}: last_synced_at set`); assert.equal(afterA.status, "connected");
  const followUp = sqlite.prepare("SELECT owner FROM deal_tasks").all();
  assert.deepEqual(followUp.map(t => t.owner), ["editor@example.com"], `${provider}: auto follow-up task owned by mailbox owner`);

  // 2. A second account seeing the same external ids writes nothing new (global dedupe; first labeller wins).
  const totals = ["inbox_messages", "activities", "deal_activities", "sync_records", "communication_review_items", "deal_tasks", "tasks"].map(count);
  const b = await addAccount("other@example.com");
  const second = await sync(b);
  assert.equal(second.emails, 0); assert.equal(second.events, 0); assert.equal(second.skipped, 2, `${provider}: both matched items skipped as already synced`);
  assert.deepEqual(["inbox_messages", "activities", "deal_activities", "sync_records", "communication_review_items", "deal_tasks", "tasks"].map(count), totals, `${provider}: no new rows`);
  assert.equal(sqlite.prepare("SELECT owner FROM inbox_messages WHERE external_id=?").get(emailId).owner, "editor@example.com");
  assert.equal(sqlite.prepare("SELECT account_id FROM sync_records WHERE external_id=?").get(emailId).account_id, a.id);

  // 3. Token refresh rejected with invalid_grant → ReconnectRequired and needs_reconnect.
  const c = await addAccount("lonely@example.com", "2000-01-01T00:00:00Z");
  tokenReply = () => Response.json({ error: "invalid_grant", error_description: "AADSTS70000: The refresh token has expired." }, { status: 400 });
  await assert.rejects(sync(c), (error) => error instanceof lib.ReconnectRequired, `${provider}: invalid_grant → ReconnectRequired`);
  assert.equal((await accounts.accountById(c.id)).status, "needs_reconnect");
  // A transient refresh failure is not a reconnect.
  sqlite.prepare("UPDATE integration_accounts SET status='connected' WHERE id=?").run(c.id);
  tokenReply = () => Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  await assert.rejects(sync(c), (error) => !(error instanceof lib.ReconnectRequired));
  assert.equal((await accounts.accountById(c.id)).status, "connected", `${provider}: transient failure leaves status alone`);
  // A token-endpoint 401 invalid_client is an app configuration problem: plain error, status unchanged.
  tokenReply = () => Response.json({ error: "invalid_client", error_description: "Bad client secret." }, { status: 401 });
  await assert.rejects(sync(c), (error) => !(error instanceof lib.ReconnectRequired), `${provider}: invalid_client is not a reconnect`);
  assert.equal((await accounts.accountById(c.id)).status, "connected", `${provider}: invalid_client leaves status alone`);
  if (provider === "microsoft") {
    tokenReply = () => Response.json({ error: "interaction_required", error_description: "AADSTS50076: MFA required." }, { status: 400 });
    await assert.rejects(sync(c), (error) => error instanceof lib.ReconnectRequired, "microsoft: interaction_required → ReconnectRequired");
    assert.equal((await accounts.accountById(c.id)).status, "needs_reconnect");
    sqlite.prepare("UPDATE integration_accounts SET status='connected' WHERE id=?").run(c.id);
  }
  // 401 from the provider right after a successful refresh → ReconnectRequired.
  tokenReply = () => Response.json({ access_token: "fresh", expires_in: 3600 });
  apiStatus = 401;
  await assert.rejects(sync(c), (error) => error instanceof lib.ReconnectRequired, `${provider}: 401 after refresh → ReconnectRequired`);
  assert.equal((await accounts.accountById(c.id)).status, "needs_reconnect");
  apiStatus = 200;

  // 4. Mailbox owner no longer an active CRM member → flagged, nothing fetched.
  const g = await addAccount("gone@example.com");
  calls.length = 0;
  await assert.rejects(sync(g), (error) => error instanceof lib.ReconnectRequired);
  assert.equal((await accounts.accountById(g.id)).status, "needs_reconnect"); assert.equal(calls.length, 0);

  // 4b. Mailbox owner downgraded to viewer → flagged, nothing fetched.
  const v = await addAccount("viewer@example.com");
  calls.length = 0;
  await assert.rejects(sync(v), (error) => error instanceof lib.ReconnectRequired && /no longer has edit access/.test(error.message));
  assert.equal((await accounts.accountById(v.id)).status, "needs_reconnect"); assert.equal(calls.length, 0, `${provider}: viewer owner fetches nothing`);

  // 5. POST /api/<provider>/sync syncs only the caller's own account.
  sqlite.prepare("UPDATE integration_accounts SET last_synced_at='2026-01-01 00:00:00' WHERE id IN (?,?)").run(a.id, b.id);
  const route = load(`app/api/${provider}/sync/route.ts`);
  const post = (email) => route.POST(new Request(`https://crm.example.com/api/${provider}/sync`, { method: "POST", headers: headers(email) }));
  const ok = await post("other@example.com");
  assert.equal(ok.status, 200); const body = await ok.json();
  assert.equal(body.accountId, b.id);
  assert.notEqual((await accounts.accountById(b.id)).last_synced_at, "2026-01-01 00:00:00", `${provider}: caller's account synced`);
  assert.equal((await accounts.accountById(a.id)).last_synced_at, "2026-01-01 00:00:00", `${provider}: other user's account untouched`);
  const log = sqlite.prepare("SELECT actor_email,entity_id FROM audit_logs WHERE action='integration.sync' ORDER BY id DESC").get();
  assert.equal(log.actor_email, "other@example.com"); assert.equal(log.entity_id, String(b.id));
  const none = await post("owner@example.com");
  assert.equal(none.status, 404); assert.deepEqual(await none.json(), { error: `Connect your ${provider === "microsoft" ? "Microsoft" : "Google"} account first.` });
  assert.equal((await post("viewer@example.com")).status, 403, `${provider}: viewers cannot sync`);
  sqlite.prepare("UPDATE integration_accounts SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(b.id);
  tokenReply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  const stale = await post("other@example.com");
  assert.equal(stale.status, 409, `${provider}: reconnect needed is a 409`); assert.match((await stale.json()).error, /reconnect/i);
  assert.equal((await accounts.accountById(b.id)).status, "needs_reconnect");
  console.log(`PASS: ${provider} per-account sync`);
}

// /api/advanced reports the caller's own Microsoft connection.
{
  const { sqlite, load } = createTestContext();
  sqlite.exec("INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('editor@example.com','Eddie','editor','{}','now','now'),('other@example.com','Otto','editor','{}','now','now')");
  sqlite.exec("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,last_synced_at,created_at,updated_at) VALUES ('microsoft','other@example.com','otto@corp.com','a','r','2099','2026-05-05','now','now')");
  const route = load("app/api/advanced/route.ts");
  const get = async (email) => (await (await route.GET(new Request("https://crm.example.com/api/advanced", { headers: headers(email) }))).json()).integration;
  assert.deepEqual([(await get("other@example.com")).connected, (await get("other@example.com")).accountEmail], [true, "otto@corp.com"]);
  assert.deepEqual([(await get("editor@example.com")).connected, (await get("editor@example.com")).accountEmail], [false, ""]);
  console.log("PASS: advanced integration status is per user");
}
