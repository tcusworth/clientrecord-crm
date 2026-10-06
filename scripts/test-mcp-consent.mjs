import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { load } = createTestContext();
const c = load("mcp/src/consent.ts");

assert.equal(c.escapeHtml(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
const page = c.consentPage({ clientName: `<img src=x onerror=alert(1)>Evil`, redirectUri: "https://claude.ai/api/mcp/auth_callback", email: "owner@example.com", role: "owner", consentId: "abc123" });
assert.ok(!page.includes("<img src=x"), "client name is escaped");
assert.ok(page.includes("claude.ai"), "redirect host shown");
assert.ok(page.includes('name="consentId" value="abc123"'));
assert.ok(/cannot delete, merge|can't delete/.test(page), "powers explained");
const cookie = c.consentCookie("abc123");
assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Max-Age=600/);
// __Host- prefix: browser enforces Secure, Path=/ and no Domain, so a sibling subdomain can't plant the cookie
assert.equal(c.CONSENT_COOKIE, "__Host-cr_consent"); assert.equal(c.CONNECTIONS_COOKIE, "__Host-cr_connections");
for (const set of [cookie, c.consentCookie("t", c.CONNECTIONS_COOKIE), c.clearConsentCookie(), c.clearConsentCookie(c.CONNECTIONS_COOKIE)]) { assert.match(set, /^__Host-cr_(consent|connections)=/); assert.match(set, /; Path=\/;/); assert.match(set, /Secure/); assert.doesNotMatch(set, /Domain=/i); }
assert.equal(c.readCookie(new Request("https://mcp.example/authorize", { headers: { cookie: "a=1; cr_consent=forged; __Host-cr_consent=abc123; b=2" } }), c.CONSENT_COOKIE), "abc123");
assert.equal(c.readCookie(new Request("https://mcp.example/authorize"), c.CONSENT_COOKIE), null);

// identity: dev bypass only on localhost; otherwise requires a verified Access JWT
assert.deepEqual(await c.identify(new Request("http://127.0.0.1:8788/authorize"), { DEV_AUTHORIZE_AS: "Owner@Example.com" }), { email: "owner@example.com" });
assert.equal(await c.identify(new Request("https://mcp.clientrecordcrm.com/authorize"), { DEV_AUTHORIZE_AS: "owner@example.com" }), null, "dev bypass ignored off localhost");
assert.equal(await c.identify(new Request("https://mcp.clientrecordcrm.com/authorize", { headers: { "cf-access-jwt-assertion": "not.a.jwt" } }), { CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", CF_ACCESS_AUD: "aud" }), null, "invalid JWT rejected");
assert.equal(await c.identify(new Request("https://mcp.clientrecordcrm.com/authorize"), {}), null);

const conn = c.connectionsPage({ email: "o@example.com", grants: [{ id: "g1", clientName: "<b>Claude</b>", createdAt: 1790000000 }], token: "tok" });
assert.ok(conn.includes("&lt;b&gt;Claude&lt;/b&gt;")); assert.ok(conn.includes('name="grantId" value="g1"')); assert.ok(conn.includes('name="token" value="tok"'));
console.log("PASS: consent helpers — escaping, cookie flags, identity rules, pages");
