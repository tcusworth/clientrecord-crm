import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";
const { sqlite } = createTestContext();
const ins = (p, u) => sqlite.prepare("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,created_at,updated_at) VALUES (?,?,?,'a','r','2099-01-01','now','now')").run(p, u, u || "co@x.com");
ins("microsoft", "a@x.com"); ins("microsoft", "b@x.com"); ins("quickbooks", "");
assert.throws(() => ins("microsoft", "a@x.com"), /UNIQUE/);
assert.throws(() => ins("quickbooks", ""), /UNIQUE/);
assert.equal(sqlite.prepare("SELECT status FROM integration_accounts WHERE user_email='a@x.com'").get().status, "connected");
sqlite.prepare("INSERT INTO sync_records(provider,external_id,item_type,account_id,occurred_at,created_at) VALUES ('microsoft','m1','email',1,'now','now')").run();
assert.equal(sqlite.prepare("SELECT account_id FROM sync_records WHERE external_id='m1'").get().account_id, 1);
sqlite.prepare("INSERT INTO inbox_messages(id,from_email,account_id,occurred_at,created_at,updated_at) VALUES ('i1','x@y.com',2,'now','now','now')").run();
assert.equal(sqlite.prepare("SELECT account_id FROM inbox_messages WHERE id='i1'").get().account_id, 2);
const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='integration_accounts'").all().map(r => r.name);
assert.ok(idx.includes("integration_accounts_provider_user_unique") && !idx.includes("integration_accounts_provider_unique"));
console.log("PASS: personal connections schema");

// Task 2: per-user connect and callback.
{
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const { sqlite, load } = createTestContext({ MS_CLIENT_ID: "ms-id", MS_CLIENT_SECRET: "ms-secret", GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret", CRM_TOKEN_ENCRYPTION_KEY: key });
  sqlite.exec("INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('editor@example.com','Eddie','editor','{}','now','now'),('Mixed@Example.com','Mia','editor','{}','now','now'),('viewer@example.com','Vera','viewer','{}','now','now'),('gone@example.com','Gus','editor','{}','now','now')");
  sqlite.exec("UPDATE team_members SET active=0 WHERE email='gone@example.com'");
  const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email });
  const accounts = load("lib/integrations/accounts.ts"), { decryptToken } = load("lib/microsoft.ts");
  const rows = () => sqlite.prepare("SELECT * FROM integration_accounts ORDER BY id").all();
  sqlite.exec("DELETE FROM integration_accounts");

  for (const provider of ["microsoft", "google"]) {
    const connect = load(`app/api/${provider}/connect/route.ts`);
    const res = await connect.GET(new Request(`https://crm.example.com/api/${provider}/connect`, { headers: headers("editor@example.com") }));
    assert.equal(res.status, 302, `${provider} editor connect redirects`);
    const state = new URL(res.headers.get("location")).searchParams.get("state");
    assert.equal(sqlite.prepare("SELECT actor_email FROM oauth_states WHERE state=?").get(state).actor_email, "editor@example.com");
    assert.equal(res.headers.get("set-cookie"), `__Host-cr_oauth_${provider}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`, `${provider} connect binds the browser`);
    assert.equal((await connect.GET(new Request(`https://crm.example.com/api/${provider}/connect`, { headers: headers("viewer@example.com") }))).status, 403, `${provider} viewer gets 403`);
  }

  // upsertPersonalAccount: one row per (provider,user), update in place, keep refresh token on '', reset status.
  const base = { provider: "microsoft", accessTokenEnc: "acc1", refreshTokenEnc: "ref1", expiresAt: "2099-01-01", scopes: "s" };
  const idA = await accounts.upsertPersonalAccount({ ...base, userEmail: "a@x.com", accountEmail: "a@mail.com" });
  const idB = await accounts.upsertPersonalAccount({ ...base, userEmail: "b@x.com", accountEmail: "b@mail.com" });
  assert.notEqual(idA, idB); assert.equal(rows().length, 2);
  sqlite.exec("UPDATE integration_accounts SET status='needs_reconnect' WHERE user_email='a@x.com'");
  const idA2 = await accounts.upsertPersonalAccount({ ...base, userEmail: "a@x.com", accountEmail: "a2@mail.com", accessTokenEnc: "acc2", refreshTokenEnc: "" });
  assert.equal(idA2, idA); assert.equal(rows().length, 2);
  const a = await accounts.ownAccount("microsoft", "a@x.com");
  assert.deepEqual([a.account_email, a.access_token, a.refresh_token, a.status], ["a2@mail.com", "acc2", "ref1", "connected"]);
  assert.equal((await accounts.accountById(idB)).user_email, "b@x.com");
  assert.equal(await accounts.ownAccount("google", "a@x.com"), null);
  sqlite.exec("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,created_at,updated_at) VALUES ('quickbooks','','qb','a','r','2099','now','now')");
  assert.deepEqual((await accounts.allPersonalAccounts()).map(r => r.user_email).sort(), ["a@x.com", "b@x.com"]);
  const user = role => ({ id: "u", email: "u@x.com", role, permissions: [] });
  assert.equal(accounts.canConnectOwn({ ...user("editor"), permissions: ["records.edit"] }), true);
  assert.equal(accounts.canConnectOwn({ ...user("viewer"), permissions: ["records.view"] }), false);
  assert.equal(accounts.canManageAll({ ...user("editor"), permissions: ["records.edit"] }), false);
  assert.equal(accounts.canManageAll({ ...user("admin"), permissions: ["integrations.manage"] }), true);
  sqlite.exec("DELETE FROM integration_accounts");

  sqlite.exec("DELETE FROM oauth_states");
  // Callbacks: stub token + profile calls; never hit real endpoints.
  let tokenResponse = {};
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/v2.0/token") || u === "https://oauth2.googleapis.com/token") return Response.json(tokenResponse);
    if (u.startsWith("https://graph.microsoft.com/v1.0/me")) return Response.json({ mail: "Box@Corp.com" });
    if (u.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return Response.json({ email: "box@gmail.com" });
    throw new Error(`Unexpected fetch ${u}`);
  };
  const newState = actor => { const s = crypto.randomUUID(); sqlite.prepare("INSERT INTO oauth_states(state,actor_email,expires_at,created_at) VALUES (?,?,datetime('now','+10 minutes'),datetime('now'))").run(s, actor); return s; };
  // Default: the callback path bypasses Access (no session) and the browser carries the matching state cookie.
  let lastCookie = "";
  const callback = async (provider, actor, { signedIn = null, cookie = s => s } = {}) => {
    const state = newState(actor), c = cookie(state);
    const res = await load(`app/api/${provider}/callback/route.ts`).GET(new Request(`https://crm.example.com/api/${provider}/callback?code=c&state=${state}`, { headers: { ...(signedIn ? headers(signedIn) : {}), ...(c == null ? {} : { cookie: `other=1; __Host-cr_oauth_${provider}=${c}` }) } }));
    lastCookie = res.headers.get("set-cookie"); return res.headers.get("location");
  };

  for (const provider of ["microsoft", "google"]) {
    tokenResponse = { access_token: `${provider}-acc`, refresh_token: `${provider}-ref`, expires_in: 3600, scope: "x" };
    assert.match(await callback(provider, "Mixed@Example.com"), new RegExp(`integration=${provider}_connected`));
    assert.match(await callback(provider, "editor@example.com", { signedIn: "editor@example.com" }), new RegExp(`integration=${provider}_connected`), `${provider}: matching cookie + matching session succeeds`);
    assert.match(lastCookie, /Max-Age=0$/, `${provider}: success clears the cookie`);
    const mine = rows().filter(r => r.provider === provider);
    assert.deepEqual(mine.map(r => r.user_email).sort(), ["editor@example.com", "mixed@example.com"], `${provider}: one row per CRM user, lowercased`);
    assert.equal(await decryptToken(mine[0].refresh_token), `${provider}-ref`);
    const log = sqlite.prepare("SELECT actor_email,changes FROM audit_logs WHERE action='integration.connect' ORDER BY id DESC").get();
    assert.equal(log.actor_email, "editor@example.com");
    assert.equal(JSON.parse(log.changes).provider, provider); assert.equal(JSON.parse(log.changes).userEmail, "editor@example.com"); assert.ok(JSON.parse(log.changes).accountEmail);
    // A state whose actor is no longer an active CRM user is refused.
    const before = rows().length;
    assert.match(await callback(provider, "gone@example.com"), new RegExp(`integration=${provider}_error`));
    assert.match(await callback(provider, "stranger@example.com"), new RegExp(`integration=${provider}_error`));
    // Browser binding: the state cookie must be present and match; a signed-in identity, if any, must be the actor.
    assert.match(await callback(provider, "editor@example.com", { cookie: () => null }), new RegExp(`integration=${provider}_error`), `${provider}: missing cookie refused`);
    assert.match(await callback(provider, "editor@example.com", { cookie: () => crypto.randomUUID() }), new RegExp(`integration=${provider}_error`), `${provider}: wrong cookie refused`);
    assert.match(await callback(provider, "editor@example.com", { signedIn: "mixed@example.com" }), new RegExp(`integration=${provider}_error`), `${provider}: different signed-in user refused`);
    assert.equal(lastCookie, `__Host-cr_oauth_${provider}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`, `${provider}: refusal clears the cookie`);
    // Actor downgraded to viewer while the state was outstanding.
    sqlite.exec("UPDATE team_members SET role='viewer' WHERE email='Mixed@Example.com'");
    assert.match(await callback(provider, "Mixed@Example.com"), new RegExp(`integration=${provider}_error`), `${provider}: downgraded actor refused`);
    sqlite.exec("UPDATE team_members SET role='editor' WHERE email='Mixed@Example.com'");
    assert.equal(rows().length, before, `${provider}: refused states write nothing`);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM oauth_states").get().n, 0, `${provider}: refused states are still consumed`);
  }

  // Microsoft without a refresh token: only the actor's own stored token counts.
  tokenResponse = { access_token: "acc-new", expires_in: 3600, scope: "x" };
  sqlite.exec("INSERT INTO team_members(email,name,role,permissions,created_at,updated_at) VALUES ('new@example.com','Nia','editor','{}','now','now')");
  assert.match(await callback("microsoft", "new@example.com"), /integration=microsoft_error/, "another user's refresh token is not a fallback");
  assert.equal(await accounts.ownAccount("microsoft", "new@example.com"), null);
  assert.match(await callback("microsoft", "editor@example.com"), /integration=microsoft_connected/, "own stored refresh token is reused");
  const ed = await accounts.ownAccount("microsoft", "editor@example.com");
  assert.equal(await decryptToken(ed.refresh_token), "microsoft-ref"); assert.equal(await decryptToken(ed.access_token), "acc-new");
  console.log("PASS: per-user connect and callback");
}
