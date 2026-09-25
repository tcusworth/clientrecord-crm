import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createModuleLoader } from "./test-helpers.mjs";

const { verifiedCloudflareAccessIdentity } = createModuleLoader()("lib/cloudflare-access.ts");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "test-key";
jwk.alg = "RS256";
jwk.use = "sig";

const teamDomain = "https://clientrecord-test.cloudflareaccess.com";
const audience = "clientrecord-audience";
const now = Math.floor(Date.now() / 1000);
const base64url = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims = {}, key = privateKey) => {
  const header = base64url({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = base64url({ iss: teamDomain, aud: audience, sub: "user-123", email: "OWNER@EXAMPLE.COM", exp: now + 300, ...claims });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${signature}`;
};
const request = value => new Request("https://clientrecordcrm.com/api/crm", { headers: { "cf-access-jwt-assertion": value } });

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(String(url), `${teamDomain}/cdn-cgi/access/certs`);
  return { ok: true, json: async () => ({ keys: [jwk] }) };
};

try {
  const identity = await verifiedCloudflareAccessIdentity(request(token()), teamDomain, audience);
  assert.deepEqual(identity, { id: "cf-access:user-123", email: "owner@example.com" });
  assert.equal(await verifiedCloudflareAccessIdentity(request(token({ aud: "wrong" })), teamDomain, audience), null);
  assert.equal(await verifiedCloudflareAccessIdentity(request(token({ iss: "https://wrong.cloudflareaccess.com" })), teamDomain, audience), null);
  assert.equal(await verifiedCloudflareAccessIdentity(request(token({ exp: now - 60 })), teamDomain, audience), null);
  assert.equal(await verifiedCloudflareAccessIdentity(request(`${token()}tampered`), teamDomain, audience), null);
  assert.equal(await verifiedCloudflareAccessIdentity(request(token()), "https://example.com", audience), null);
  assert.equal(await verifiedCloudflareAccessIdentity(new Request("https://clientrecordcrm.com"), teamDomain, audience), null);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS: Cloudflare Access JWT signature, issuer, audience, expiry, identity normalization, and missing-token checks.");
