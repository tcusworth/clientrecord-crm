import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext({ RESEND_API_KEY: "re_test" });
const lists = load("lib/contact-lists.ts"), crm = load("app/api/crm/route.ts");
const realFetch = globalThis.fetch; let resendCalls = [];
globalThis.fetch = async (url, init = {}) => { resendCalls.push({ url: String(url), init }); return new Response(JSON.stringify({ id: "rs_1" }), { status: 200, headers: { "content-type": "application/json" } }); };
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
function member(email, role, permissions) { sqlite.prepare("INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES (?,?,?,?,'now','now')").run(email, email, role, JSON.stringify(permissions)); }
const post = async (email, body) => { const response = await crm.POST(new Request("https://crm.example.com/api/crm", { method: "POST", headers: headers(email), body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
const count = sql => sqlite.prepare(sql).get().n;

try {
  member("owner@example.com", "owner", ["records.view", "records.edit", "records.delete", "settings.manage", "campaigns.send"]);
  member("editor@example.com", "editor", ["records.view", "records.edit", "campaigns.send"]);
  member("viewer@example.com", "viewer", ["records.view"]);

  const contact = (first, email, subscribed, firstSource = "", latestSource = "") => Number(sqlite.prepare("INSERT INTO contacts(first_name,last_name,email,subscribed,first_source,latest_source,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,'[]',datetime('now'),datetime('now'))").run(first, "Test", email, subscribed, firstSource, latestSource).lastInsertRowid);
  const a = contact("Ann", "ann@example.com", 1, "web-form", "web-form"), b = contact("Bob", "bob@example.com", 1, "web-form", "ebook"), c = contact("Cy", "cy@example.com", 0), outsider = contact("Out", "out@example.com", 1);
  const listId = Number(sqlite.prepare("INSERT INTO contact_lists(name,created_at) VALUES ('Spring Report',datetime('now'))").run().lastInsertRowid);
  Number(sqlite.prepare("INSERT INTO contact_lists(name,created_at) VALUES ('Other',datetime('now'))").run().lastInsertRowid);
  for (const id of [a, b, c]) sqlite.prepare("INSERT INTO contact_list_members(list_id,contact_id,added_at,source) VALUES (?,?,'2026-10-01','web-form')").run(listId, id);

  // Counts and members.
  const all = await lists.listContactLists(), spring = all.find(l => l.id === listId);
  assert.equal(spring.memberCount, 3); assert.equal(spring.subscribedCount, 2); assert.equal(all.find(l => l.name === "Other").memberCount, 0);
  assert.deepEqual([...await lists.listMemberIds(listId)].sort(), [a, b, c].sort());
  const members = await lists.listMembers(listId);
  assert.equal(members.length, 3); assert.equal(members.find(m => m.contactId === c).subscribed, false); assert.equal(members[0].source, "web-form");
  assert.deepEqual((await lists.contactListsFor(a)).map(l => l.name), ["Spring Report"]);

  // list:{id} audience selects only subscribed members (observed through the Resend segment add calls).
  sqlite.prepare("INSERT INTO campaigns(name,subject,html,text_body,status,audience,recipient_count,created_at,updated_at) VALUES ('C','S','<p>x</p>','x','Draft',?,0,date('now'),datetime('now'))").run(`list:${listId}`);
  const campaignId = Number(sqlite.prepare("SELECT max(id) AS n FROM campaigns").get().n);
  const sync = await post("owner@example.com", { action: "syncCampaignAudience", id: campaignId });
  assert.equal(sync.status, 200, JSON.stringify(sync.body)); assert.equal(sync.body.recipientCount, 2);
  const adds = resendCalls.filter(call => /\/segments\/rs_1$/.test(call.url)).map(call => decodeURIComponent(call.url.split("/contacts/")[1].split("/segments")[0])).sort();
  assert.deepEqual(adds, ["ann@example.com", "bob@example.com"], "only subscribed list members join the segment");
  sqlite.prepare("UPDATE campaigns SET audience='list:99999' WHERE id=?").run(campaignId);
  assert.equal((await post("owner@example.com", { action: "syncCampaignAudience", id: campaignId })).status === 200, false, "an unknown list matches nobody");

  // GET payload and contact rows.
  const get = await crm.GET(new Request("https://crm.example.com/api/crm", { headers: headers("viewer@example.com") })), payload = await get.json();
  assert.equal(get.status, 200); assert.equal(payload.lists.find(l => l.id === listId).subscribedCount, 2);
  const rows = (await (await crm.GET(new Request("https://crm.example.com/api/crm?resource=contacts&limit=50", { headers: headers("viewer@example.com") }))).json()).rows;
  const bob = rows.find(r => r.id === b);
  assert.deepEqual(bob.lists, ["Spring Report"]); assert.equal(bob.firstSource, "web-form"); assert.equal(bob.latestSource, "ebook");
  assert.deepEqual(rows.find(r => r.id === outsider).lists, []);

  // Permissions.
  assert.equal((await post("viewer@example.com", { action: "removeListMember", listId, contactId: a })).status, 403);
  assert.equal((await post("editor@example.com", { action: "deleteList", id: listId })).status, 403, "editors lack settings.manage");
  assert.equal((await post("editor@example.com", { action: "renameList", id: listId, name: "X" })).status, 403);
  assert.equal(count(`SELECT count(*) AS n FROM contact_list_members WHERE list_id=${listId}`), 3);

  // removeListMember.
  assert.equal((await post("editor@example.com", { action: "removeListMember", listId, contactId: c })).status, 200);
  assert.equal((await lists.listContactLists()).find(l => l.id === listId).memberCount, 2);
  assert.equal(count(`SELECT count(*) AS n FROM contacts WHERE id=${c}`), 1, "the contact itself stays");

  // Rename.
  await assert.rejects(lists.renameList(listId, "other"), /already exists/);
  await assert.rejects(lists.renameList(listId, "OTHER"), /already exists/);
  await assert.rejects(lists.renameList(listId, ""), /1.120 characters/);
  await assert.rejects(lists.renameList(listId, "x".repeat(121)), /1.120 characters/);
  await lists.renameList(listId, "Spring Report");
  assert.equal((await post("owner@example.com", { action: "renameList", id: listId, name: "Q2 Report" })).status, 200);
  assert.equal((await post("owner@example.com", { action: "renameList", id: listId, name: "Other" })).status, 400);
  assert.equal(count(`SELECT count(*) AS n FROM contact_lists WHERE name='Q2 Report'`), 1);

  // Delete removes memberships, not contacts.
  assert.equal((await post("owner@example.com", { action: "deleteList", id: listId })).status, 200);
  assert.equal(count(`SELECT count(*) AS n FROM contact_list_members WHERE list_id=${listId}`), 0);
  assert.equal(count("SELECT count(*) AS n FROM contacts"), 4);
  assert.equal(count(`SELECT count(*) AS n FROM contact_lists WHERE id=${listId}`), 0);
  console.log("contact lists tests passed");
} finally { globalThis.fetch = realFetch; }
