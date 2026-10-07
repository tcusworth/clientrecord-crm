// Task 5: automatic sync of every connected account (syncAllAccounts, hourly cron, daily maintenance). Provider calls are stubbed.
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const { sqlite, env, load } = createTestContext({ MS_CLIENT_ID: "ms-id", MS_CLIENT_SECRET: "ms-secret", GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret", CRM_TOKEN_ENCRYPTION_KEY: key });
env.BUCKET = { async put() {} };
sqlite.exec(`INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('bad@example.com','Bad','editor','{}','now','now'),('good@example.com','Good','editor','{}','now','now'),('boom@example.com','Boom','editor','{}','now','now');`);
const { encryptToken } = load("lib/microsoft.ts");
const { syncAllAccounts } = load("lib/integrations/sync-all.ts");
const { runScheduled } = load("lib/scheduled-jobs.ts");
const { runDailyMaintenance } = load("lib/operations.ts");
const add = async (provider, userEmail) => sqlite.prepare("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'2000-01-01T00:00:00Z','now','now')").run(provider, userEmail, `${userEmail}.box`, await encryptToken("acc"), await encryptToken("ref")).lastInsertRowid;
const bad = Number(await add("microsoft", "bad@example.com")), good = Number(await add("google", "good@example.com"));
const status = id => sqlite.prepare("SELECT status,last_synced_at FROM integration_accounts WHERE id=?").get(id);
const jobs = () => sqlite.prepare("SELECT status,processed,failed FROM job_runs WHERE job_type='mail-sync' ORDER BY id").all().map(r => ({ ...r }));

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/oauth2/v2.0/token")) return Response.json({ error: "invalid_grant" }, { status: 400 });
  if (u === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fresh", expires_in: 3600 });
  if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({ messages: [] });
  if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) return Response.json({ items: [] });
  if (u.startsWith("https://www.googleapis.com/oauth2")) return Response.json({ email: "good@example.com.box" });
  throw new Error(`Unexpected fetch ${u}`);
};

// 1. One account hits invalid_grant, the other syncs; the failure is flagged, audited and logged, never thrown.
let result = await syncAllAccounts();
assert.equal(result.synced, 1); assert.equal(result.skipped, 0);
assert.deepEqual(result.failed.map(f => [f.accountId, f.userEmail]), [[bad, "bad@example.com"]]);
assert.equal(status(bad).status, "needs_reconnect"); assert.equal(status(good).status, "connected"); assert.ok(status(good).last_synced_at);
assert.deepEqual(jobs(), [{ status: "Completed", processed: 1, failed: 1 }]);
assert.equal(sqlite.prepare("SELECT count(*) n FROM system_events WHERE severity='warning' AND category='integration'").get().n, 1);
const audits = sqlite.prepare("SELECT actor_email,action,entity_id,changes FROM audit_logs WHERE action='integration.sync' ORDER BY id").all().map(r => ({ ...r, changes: JSON.parse(r.changes) }));
assert.equal(audits.length, 2);
assert.ok(audits.every(a => a.actor_email === "system:schedule" && a.changes.trigger === "schedule"));
const byUser = Object.fromEntries(audits.map(a => [a.changes.userEmail, a]));
assert.equal(byUser["good@example.com"].changes.provider, "google"); assert.equal(byUser["good@example.com"].changes.outcome, "success");
assert.equal(byUser["bad@example.com"].changes.provider, "microsoft"); assert.equal(byUser["bad@example.com"].changes.outcome, "failure");

// 2. Second call: the good account is inside the 50 minute guard, the bad one is needs_reconnect: both skipped, no audit.
result = await syncAllAccounts();
assert.deepEqual({ synced: result.synced, skipped: result.skipped, failed: result.failed }, { synced: 0, skipped: 2, failed: [] });
assert.equal(sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='integration.sync'").get().n, 2);
// ...and 51 minutes later the good account runs again.
result = await syncAllAccounts(new Date(Date.now() + 51 * 60000));
assert.equal(result.synced, 1); assert.equal(result.skipped, 1);

// 3. A thrown (non-token) error in one account does not stop the others.
const boom = Number(await add("microsoft", "boom@example.com"));
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL WHERE id=?").run(good);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => { if (String(url).includes("/oauth2/v2.0/token")) throw new Error("network down"); return realFetch(url, ...rest); };
const previous = console.error; console.error = () => {};
try { result = await syncAllAccounts(new Date(Date.now() + 120 * 60000)); } finally { console.error = previous; }
globalThis.fetch = realFetch;
assert.equal(result.synced, 1); assert.deepEqual(result.failed.map(f => f.accountId), [boom]); assert.match(result.failed[0].error, /network down/);
assert.equal(status(boom).status, "connected", "transient failure does not force a reconnect");
assert.equal(sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='integration.sync' AND entity_id=?").get(String(boom)).n, 1);

// 4. The hourly scheduled run (non-6 AM) syncs accounts; daily maintenance does too and is not failed by sync errors.
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL").run();
sqlite.exec("DELETE FROM job_runs");
const run = await runScheduled(new Date("2026-07-15T13:00:00Z").getTime());
assert.equal(run.localHour, 7); assert.deepEqual(run.errors, []); assert.equal(run.mailSync.synced, 1);
assert.equal(jobs().length, 1);
sqlite.exec("DELETE FROM job_runs");
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL").run();
await runDailyMaintenance("owner@example.com");
assert.equal(jobs().length, 1);
assert.deepEqual(sqlite.prepare("SELECT status FROM job_runs WHERE job_type='daily-maintenance'").all().map(r => r.status), ["Completed"]);
// 5. 6 AM paths: maintenance ran -> exactly one sync; maintenance skipped by its 20 h guard -> the hourly sync still runs.
sqlite.exec("DELETE FROM job_runs");
const sixAm = new Date("2026-07-15T12:00:00Z").getTime();
let six = await runScheduled(sixAm);
assert.equal(six.dailyMaintenance, true); assert.equal(six.mailSync, null); assert.deepEqual(six.errors, []);
assert.equal(jobs().length, 1, "maintenance ran: the account sync happens once");
six = await runScheduled(sixAm);
assert.equal(six.dailyMaintenance, false); assert.ok(six.mailSync, "guard skipped maintenance: hourly sync runs");
assert.equal(jobs().length, 2);

// 6. Page-load maintenance hands the sync to the scheduler instead of waiting on it.
let release; const gate = new Promise(resolve => { release = resolve; });
const gatedFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => { await gate; return gatedFetch(url, ...rest); };
sqlite.exec("DELETE FROM job_runs"); sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL, status='connected'").run();
const deferred = [];
await runDailyMaintenance("owner@example.com", work => deferred.push(work));
assert.equal(deferred.length, 1, "sync handed to defer");
assert.deepEqual(sqlite.prepare("SELECT status FROM job_runs WHERE job_type='daily-maintenance'").all().map(r => r.status), ["Completed"], "maintenance finished while the sync is still in flight");
assert.deepEqual(jobs(), [{ status: "Running", processed: 0, failed: 0 }]);
// 7. Concurrency guard: a Running run within 15 minutes makes another call back off without touching accounts.
const backoff = await syncAllAccounts();
assert.equal(backoff.synced, 0); assert.ok(backoff.skipped >= 1); assert.equal(jobs().length, 1);
release(); await deferred[0];
globalThis.fetch = gatedFetch;
assert.equal(jobs()[0].status, "Completed");
// ...but a stale Running row (older than 15 minutes) does not block.
sqlite.prepare("INSERT INTO job_runs(job_type,status,started_at) VALUES ('mail-sync','Running',datetime('now','-30 minutes'))").run();
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL").run();
assert.ok((await syncAllAccounts()).synced >= 1);

// 8. Audit is always written; the webhook only for failures or when something was imported.
sqlite.exec("INSERT INTO webhook_endpoints(id,name,url,events,secret_encrypted,active,created_at) VALUES ('wh','Hook','https://hooks.example.com','*','x',1,'now')");
const hooks = () => sqlite.prepare("SELECT count(*) n FROM webhook_deliveries WHERE event='integration.sync'").get().n, auditRows = () => sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='integration.sync'").get().n;
const priorHooks = hooks(), priorAudit = auditRows();
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL, status='connected'").run();
sqlite.prepare("DELETE FROM integration_accounts WHERE id!=?").run(good);
await syncAllAccounts();
assert.equal(auditRows(), priorAudit + 1, "no-op sync still audited"); assert.equal(hooks(), priorHooks, "no-op sync emits no webhook");
const plain = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const u = String(url);
  if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({ messages: [{ id: "g9" }] });
  if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/g9?")) return Response.json({ id: "g9", threadId: "t9", internalDate: String(Date.now() - 86400000), payload: { headers: [{ name: "From", value: "stranger@unknown.test" }, { name: "To", value: "good@example.com.box" }, { name: "Subject", value: "Hello" }] } });
  return plain(url, ...rest);
};
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL").run();
result = await syncAllAccounts();
assert.equal(result.synced, 1); assert.equal(auditRows(), priorAudit + 2); assert.equal(hooks(), priorHooks + 1, "import emits a webhook");
globalThis.fetch = async (url, ...rest) => { if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ error: "invalid_grant" }, { status: 400 }); return plain(url, ...rest); };
sqlite.prepare("UPDATE integration_accounts SET last_synced_at=NULL, expires_at='2000-01-01T00:00:00Z', status='connected'").run();
result = await syncAllAccounts();
assert.equal(result.failed.length, 1); assert.equal(auditRows(), priorAudit + 3); assert.equal(hooks(), priorHooks + 2, "failure emits a webhook");
globalThis.fetch = plain;

// A sync run that blows up outright is logged and does not fail maintenance.
sqlite.exec("DROP TABLE integration_accounts; DELETE FROM job_runs");
console.error = () => {};
try { await runDailyMaintenance("owner@example.com"); } finally { console.error = previous; }
assert.deepEqual(sqlite.prepare("SELECT status FROM job_runs WHERE job_type='daily-maintenance'").all().map(r => r.status), ["Completed"]);
assert.deepEqual(sqlite.prepare("SELECT status FROM job_runs WHERE job_type='mail-sync'").all().map(r => r.status), ["Failed"]);

console.log("PASS: syncAllAccounts skips needs_reconnect and recently synced accounts, isolates per-account failures, audits each sync as system:schedule, runs hourly and in daily maintenance.");
