export type CloudflareAccessIdentity = {
  id: string;
  email: string;
};

type AccessClaims = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
};

type AccessKeySet = { expiresAt: number; keys: JsonWebKey[] };
const keySets = new Map<string, AccessKeySet>();

function normalizeTeamDomain(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) return null;
    return `https://${url.hostname}`;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

async function accessKeys(teamDomain: string, refresh = false) {
  const cached = keySets.get(teamDomain);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Cloudflare Access signing keys are unavailable.");
  const body = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("Cloudflare Access returned no signing keys.");
  keySets.set(teamDomain, { keys: body.keys, expiresAt: Date.now() + 5 * 60 * 1000 });
  return body.keys;
}

async function signingKey(teamDomain: string, kid: string) {
  let keys = await accessKeys(teamDomain);
  let key = keys.find(candidate => candidate.kid === kid && candidate.kty === "RSA");
  if (!key) {
    keys = await accessKeys(teamDomain, true);
    key = keys.find(candidate => candidate.kid === kid && candidate.kty === "RSA");
  }
  if (!key) throw new Error("Cloudflare Access signing key was not found.");
  return crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

export async function verifiedCloudflareAccessIdentity(
  request: Request,
  teamDomainValue: unknown,
  audienceValue: unknown,
): Promise<CloudflareAccessIdentity | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const teamDomain = normalizeTeamDomain(teamDomainValue);
  const audience = String(audienceValue || "").trim();
  if (!token || !teamDomain || !audience) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const protectedHeader = decodeJson<{ alg?: string; kid?: string }>(encodedHeader);
    if (protectedHeader.alg !== "RS256" || !protectedHeader.kid) return null;
    const key = await signingKey(teamDomain, protectedHeader.kid);
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!validSignature) return null;

    const payload = decodeJson<AccessClaims>(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    const validAudience = typeof payload.aud === "string" ? payload.aud === audience : payload.aud?.includes(audience);
    if (payload.iss !== teamDomain || !validAudience || typeof payload.exp !== "number" || payload.exp < now - 5) return null;
    if (typeof payload.nbf === "number" && payload.nbf > now + 5) return null;
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!email || !subject) return null;
    return { id: `cf-access:${subject}`, email };
  } catch {
    return null;
  }
}
