// Local end-to-end: dynamic registration → consent (dev identity) → code → token → MCP calls → revoke.
// Run against `pnpm --filter clientrecord-mcp dev` with DEV_AUTHORIZE_AS set in mcp/.dev.vars. Cookies are Secure, so they are sent by hand.
import assert from "node:assert/strict";
import crypto from "node:crypto";

const base = process.env.MCP_BASE || "http://127.0.0.1:8788", redirect = "http://127.0.0.1:9/callback";
const b64url = buf => Buffer.from(buf).toString("base64url");
const verifier = b64url(crypto.randomBytes(32)), challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const clientName = `E2E <test> ${Date.now()}`, escapedName = clientName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const form = () => ({ "content-type": "application/x-www-form-urlencoded" }), post = (url, headers, fields) => fetch(url, { method: "POST", redirect: "manual", headers: { ...form(), ...headers }, body: new URLSearchParams(fields) });

const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
assert.ok(meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint, "metadata published");
// Locally the advertised issuer is http://localhost (no port), so keep the published paths but call them on `base`.
for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) { const u = new URL(meta[k]); meta[k] = `${base}${u.pathname}`; }
const reg = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: clientName, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
assert.ok(reg.client_id, "client registered");

// Opens the consent page for a fresh authorization request; returns the cookie and consentId the server issued.
async function startConsent(state) {
  const auth = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "" }).forEach(([k, v]) => auth.searchParams.set(k, v));
  const res = await fetch(auth, { redirect: "manual" });
  assert.equal(res.status, 200); const page = await res.text();
  assert.ok(page.includes(escapedName), "client name escaped on consent page");
  assert.ok(!page.includes(clientName), "raw client name never appears on consent page");
  return { cookie: res.headers.get("set-cookie").split(";")[0], consentId: page.match(/name="consentId" value="([^"]+)"/)[1] };
}

// Malformed form bodies get the plain 400 page, never an uncaught 500 with internals.
for (const path of ["/authorize", "/connections"]) { const res = await fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "not multipart" }); assert.equal(res.status, 400, `malformed POST ${path}`); assert.ok(!/error|stack|TypeError/i.test(await res.text()), `no internals on ${path}`); }

// Deny: redirect carries error=access_denied and the state, and no code.
const denied = await startConsent("deny-state");
const deniedRes = await post(`${base}/authorize`, { cookie: denied.cookie }, { consentId: denied.consentId, decision: "deny" });
assert.equal(deniedRes.status, 302); const deniedUrl = new URL(deniedRes.headers.get("location"));
assert.equal(deniedUrl.searchParams.get("error"), "access_denied"); assert.equal(deniedUrl.searchParams.get("state"), "deny-state"); assert.ok(!deniedUrl.searchParams.get("code"));

// Allow flow.
const { cookie, consentId } = await startConsent("xyz");
const wrongCookie = await post(`${base}/authorize`, { cookie: "__Host-cr_consent=forged" }, { consentId, decision: "allow" });
assert.equal(wrongCookie.status, 400, "CSRF: forged cookie refused");
const noCookie = await post(`${base}/authorize`, {}, { consentId, decision: "allow" });
assert.equal(noCookie.status, 400, "CSRF: missing cookie refused");
const approved = await post(`${base}/authorize`, { cookie }, { consentId, decision: "allow" });
assert.equal(approved.status, 302); const back = new URL(approved.headers.get("location"));
assert.equal(back.searchParams.get("state"), "xyz"); const code = back.searchParams.get("code"); assert.ok(code);
const replay = await post(`${base}/authorize`, { cookie }, { consentId, decision: "allow" });
assert.equal(replay.status, 400, "replayed consent POST refused");

const tokenRequest = fields => fetch(meta.token_endpoint, { method: "POST", headers: form(), body: new URLSearchParams({ client_id: reg.client_id, ...fields }) });
const token = await (await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier })).json();
assert.ok(token.access_token && token.refresh_token, "tokens issued"); assert.equal(token.expires_in, 3600);

const rpc = (body, bearer = token.access_token) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "bogus")).status, 401, "bad token rejected");
const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } })).json();
assert.equal(init.result.serverInfo.name, "clientrecord");
// Stateless server: nothing to stream, so an authenticated GET (SSE) or DELETE (session end) is refused instead of hanging open.
for (const method of ["GET", "DELETE"]) { const res = await fetch(`${base}/mcp`, { method, headers: { accept: "text/event-stream", authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(5000) }); assert.equal(res.status, 405, `${method} /mcp`); assert.equal(res.headers.get("allow"), "POST"); assert.equal((await res.json()).error.code, -32000); }
const tools = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).json();
assert.equal(tools.result.tools.length, 19);
const summary = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pipeline_summary", arguments: {} } })).json();
assert.ok(!summary.result.isError, JSON.stringify(summary));
const email = `e2e-${Date.now()}@example.com`;
const created = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_contact", arguments: { firstName: "E2E", lastName: "Test", email } } })).json();
assert.ok(!created.result.isError, JSON.stringify(created));
const search = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search_crm", arguments: { query: email } } })).json();
assert.ok(search.result.content[0].text.includes(email));

const refreshed = await (await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh_token })).json();
assert.ok(refreshed.access_token, "refresh works");

// Revoke the grant belonging to this run's client (matched by its unique escaped name), not whichever grant is listed first.
const conn = await fetch(`${base}/connections`); const connPage = await conn.text(), connCookie = conn.headers.get("set-cookie").split(";")[0];
const row = connPage.split("<tr>").find(r => r.includes(`<strong>${escapedName}</strong>`)); assert.ok(row, "e2e grant listed on /connections");
const grantId = row.match(/name="grantId" value="([^"]+)"/)[1], tok = row.match(/name="token" value="([^"]+)"/)[1];
assert.equal((await post(`${base}/connections`, { cookie: "__Host-cr_connections=forged" }, { grantId, token: tok })).status, 400, "connections CSRF: forged cookie refused");
assert.equal((await post(`${base}/connections`, { cookie: connCookie }, { grantId, token: tok })).status, 303);
assert.equal((await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }, refreshed.access_token)).status, 401, "revoked grant: refreshed access token rejected");
assert.equal((await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }, token.access_token)).status, 401, "revoked grant: original access token rejected");
for (const rt of new Set([token.refresh_token, refreshed.refresh_token].filter(Boolean))) assert.ok((await tokenRequest({ grant_type: "refresh_token", refresh_token: rt })).status >= 400, "revoked grant: refresh token rejected");
console.log(`PASS: e2e — registration, consent (CSRF-protected, single-use, deny), PKCE code exchange, 19 tools, GET/DELETE /mcp 405, read + write, refresh, revoke (access + refresh tokens). Created test contact ${email}.`);
