// Personal mailbox sync: internal addresses (owner, team, owner's domain) never match CRM contacts or queue reviews.
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const past = (days) => new Date(Date.now() - days * 86400000).toISOString();
const OWN = "owner@csi-automation.com";

for (const provider of ["microsoft", "google"]) {
  const { sqlite, load } = createTestContext({ MS_CLIENT_ID: "ms-id", MS_CLIENT_SECRET: "ms-secret", GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret", CRM_TOKEN_ENCRYPTION_KEY: key });
  // The owner, a colleague, and a team member on another domain are all CRM contacts, as in production.
  sqlite.exec(`INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('editor@example.com','Eddie','editor','{}','now','now'),('mate@elsewhere.test','Mia','editor','{}','now','now'),('ex@elsewhere.test','Xan','editor','{}','now','now');
UPDATE team_members SET active=0 WHERE email='ex@elsewhere.test';
INSERT INTO companies(id,name,updated_at) VALUES (1,'Acme Industries','2026-01-01'),(2,'CSI','2026-01-01');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Casey','Client','client@acme.test','Acme Industries','2026-01-01','2026-01-01'),(2,'Own','Er','${OWN}','CSI','2026-01-01','2026-01-01'),(3,'Col','League','colleague@csi-automation.com','CSI','2026-01-01','2026-01-01'),(4,'Mia','Mate','mate@elsewhere.test','','2026-01-01','2026-01-01'),(5,'Xan','Ex','ex@elsewhere.test','','2026-01-01','2026-01-01');
INSERT INTO deals(id,name,company,company_id,contact_id,stage,stage_key,pipeline_key,owner,status,created_at,updated_at) VALUES (1,'Acme expansion','Acme Industries',1,1,'Proposal','proposal','default','editor@example.com','Open','2026-01-01','2026-01-01');
INSERT INTO automation_sequences(id,name,created_at,updated_at) VALUES (1,'Seq','now','now');`);
  const { encryptToken } = load("lib/microsoft.ts");
  const accounts = load("lib/integrations/accounts.ts");
  const lib = load(`lib/integrations/${provider}-sync.ts`);
  const sync = provider === "microsoft" ? lib.syncMicrosoftAccount : lib.syncGoogleAccount;
  sqlite.prepare("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,auto_tasks,created_at,updated_at) VALUES (?,?,?,?,?,'2099-01-01T00:00:00Z',1,'now','now')").run(provider, "editor@example.com", OWN, await encryptToken("acc"), await encryptToken("ref"));
  const account = await accounts.ownAccount(provider, "editor@example.com");

  // mail: {id, from, to[]}; meetings: {id, organizer, attendees[]}
  let mail = [], meetings = [];
  const gmailBy = (id) => mail.find((m) => m.id === id);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ mail: OWN });
    if (u.startsWith("https://graph.microsoft.com/v1.0/me/messages?")) return Response.json({ value: mail.map((m) => ({ id: m.id, conversationId: `c-${m.id}`, subject: `S ${m.id}`, bodyPreview: "body", from: { emailAddress: { address: m.from } }, toRecipients: m.to.map((address) => ({ emailAddress: { address } })), receivedDateTime: past(1), hasAttachments: false })) });
    if (u.startsWith("https://graph.microsoft.com/v1.0/me/calendarView?")) return Response.json({ value: meetings.map((e) => ({ id: e.id, subject: `M ${e.id}`, start: { dateTime: past(2) }, end: { dateTime: past(2) }, organizer: { emailAddress: { address: e.organizer } }, attendees: e.attendees.map((address) => ({ emailAddress: { address } })) })) });
    if (u.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return Response.json({ messages: mail.map((m) => ({ id: m.id })) });
    const g = u.match(/gmail\/v1\/users\/me\/messages\/([^?]+)\?/);
    if (g) { const m = gmailBy(g[1]); return Response.json({ id: m.id, threadId: `t-${m.id}`, internalDate: String(Date.now() - 86400000), payload: { headers: [{ name: "From", value: m.from }, { name: "To", value: m.to.join(", ") }, { name: "Subject", value: `S ${m.id}` }] } }); }
    if (u.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) return Response.json({ items: meetings.map((e) => ({ id: e.id, summary: `M ${e.id}`, start: { dateTime: past(2) }, end: { dateTime: past(2) }, organizer: { email: e.organizer }, attendees: e.attendees.map((email) => ({ email })) })) });
    throw new Error(`Unexpected fetch ${u}`);
  };
  const run = async (m, e = []) => { mail = m; meetings = e; for (const t of ["sync_records", "inbox_messages", "activities", "deal_activities", "communication_review_items", "deal_tasks", "tasks"]) sqlite.exec(`DELETE FROM ${t}`); return sync(account); };
  const ids = (table, col = "external_id") => sqlite.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY ${col}`).all().map((r) => r.v);
  const reviews = () => sqlite.prepare("SELECT source_id,sender_email,kind FROM communication_review_items").all().map((r) => ({ ...r }));

  // Inbound spam to the owner from a non-contact: neither logged nor queued.
  let r = await run([{ id: "spam", from: "noreply@spam.test", to: [OWN] }]);
  assert.deepEqual([r.emails, r.reviewQueued], [0, 0], `${provider}: spam ignored`);
  assert.deepEqual(ids("sync_records"), []); assert.deepEqual(reviews(), []);

  // Inbound from an external contact: logged against that contact, not the owner.
  r = await run([{ id: "in", from: "Client@Acme.test", to: [OWN] }]);
  assert.equal(r.emails, 1, `${provider}: external contact inbound logged`);
  const row = sqlite.prepare("SELECT contact_id,direction,from_email FROM inbox_messages").get();
  assert.deepEqual({ ...row }, { contact_id: 1, direction: "Inbound", from_email: "client@acme.test" });

  // Internal-only mail (colleague, team member on another domain, inactive member, the owner themselves): not logged, not queued.
  r = await run([
    { id: "col", from: "colleague@csi-automation.com", to: [OWN] }, { id: "team", from: "mate@elsewhere.test", to: [OWN] },
    { id: "gone", from: "ex@elsewhere.test", to: [OWN] }, { id: "self", from: OWN, to: [OWN] }, { id: "dom", from: "stranger@csi-automation.com", to: [OWN] },
  ]);
  assert.deepEqual([r.emails, r.reviewQueued], [0, 0], `${provider}: internal mail ignored`);
  assert.deepEqual(ids("sync_records"), []); assert.deepEqual(reviews(), []);

  // Owner writes to an external contact: logged as outbound.
  r = await run([{ id: "out", from: OWN, to: ["client@acme.test"] }]);
  assert.equal(r.emails, 1);
  assert.deepEqual({ ...sqlite.prepare("SELECT contact_id,direction,from_email FROM inbox_messages").get() }, { contact_id: 1, direction: "Outbound", from_email: OWN });

  // Owner cc's a colleague and writes to a contact: the colleague is not the match.
  r = await run([{ id: "mix", from: OWN, to: ["colleague@csi-automation.com", "client@acme.test"] }]);
  assert.equal(r.emails, 1); assert.equal(sqlite.prepare("SELECT contact_id FROM inbox_messages").get().contact_id, 1);

  // Owner writes to an unknown external address: queued for review (only the external one).
  r = await run([{ id: "new", from: OWN, to: ["colleague@csi-automation.com", "prospect@newco.test"] }]);
  assert.deepEqual([r.emails, r.reviewQueued], [0, 1]);
  assert.deepEqual(reviews(), [{ source_id: "new", sender_email: "prospect@newco.test", kind: "Unknown contact" }]);
  // Owner writes only to internal addresses: nothing queued.
  r = await run([{ id: "int", from: OWN, to: ["colleague@csi-automation.com", "mate@elsewhere.test"] }]);
  assert.deepEqual([r.emails, r.reviewQueued], [0, 0]);

  // Reply detection still works: an external contact's reply stops their active sequence.
    sqlite.exec("DELETE FROM automation_enrollments; INSERT INTO automation_enrollments(sequence_id,contact_id,next_run_at,enrolled_at) VALUES (1,1,'now','now')");
  r = await run([{ id: "reply", from: "client@acme.test", to: [OWN] }]);
  assert.equal(r.replies, 1, `${provider}: reply from contact detected`);
  assert.equal(sqlite.prepare("SELECT status FROM automation_enrollments WHERE contact_id=1").get().status, "Replied");

  // Meetings: owner + colleagues only (owner and colleague are CRM contacts): not logged, no task.
  r = await run([], [{ id: "int-mtg", organizer: OWN, attendees: ["colleague@csi-automation.com", "mate@elsewhere.test", OWN] }]);
  assert.deepEqual([r.events, r.tasks], [0, 0], `${provider}: internal meeting ignored`);
  assert.deepEqual([ids("sync_records"), ids("deal_tasks", "title"), ids("tasks", "title")], [[], [], []]);
  // Meeting with an external contact: logged against them, with a follow-up task.
  r = await run([], [{ id: "ext-mtg", organizer: OWN, attendees: ["colleague@csi-automation.com", "client@acme.test"] }]);
  assert.deepEqual([r.events, r.tasks], [1, 1], `${provider}: external meeting logged with task`);
  assert.equal(sqlite.prepare("SELECT contact_id FROM sync_records").get().contact_id, 1);
  assert.deepEqual(ids("deal_tasks", "title"), ["Follow up: M ext-mtg"]);
  // Meeting with an unknown external attendee: unchanged (not logged, no review).
  r = await run([], [{ id: "unk-mtg", organizer: OWN, attendees: ["prospect@newco.test"] }]);
  assert.deepEqual([r.events, r.tasks, r.reviewQueued], [0, 0, 0]);
  console.log(`PASS: ${provider} sync ignores internal addresses`);
}

// Free-mail owner: a gmail.com mailbox must not make every gmail contact "internal".
{
  const { sqlite, load } = createTestContext();
  sqlite.exec("INSERT INTO contacts(id,first_name,last_name,email,created_at,updated_at) VALUES (1,'G','Mail','friend@gmail.com','now','now')");
  const matcher = await load("lib/integrations/matching.ts").loadInternalMatcher(["me@gmail.com", "me@gmail.com"]);
  assert.deepEqual(matcher.external(["me@gmail.com", "friend@gmail.com", "Friend@gmail.com"]), ["friend@gmail.com"]);
  console.log("PASS: free-mail domain is not an internal domain");
}
