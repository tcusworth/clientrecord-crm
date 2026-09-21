import { env } from "cloudflare:workers";

const tenant = () => String(env.MS_TENANT_ID || "common");
export const microsoftConfigured = () => Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.CRM_TOKEN_ENCRYPTION_KEY);
export const microsoftRedirect = (origin: string) => `${origin}/api/microsoft/callback`;

function bytes(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
function encoded(value: Uint8Array) { let raw = ""; value.forEach(v => raw += String.fromCharCode(v)); return btoa(raw); }
async function cryptoKey() { return crypto.subtle.importKey("raw", bytes(String(env.CRM_TOKEN_ENCRYPTION_KEY)), "AES-GCM", false, ["encrypt", "decrypt"]); }
export async function encryptToken(value: string) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), new TextEncoder().encode(value))); return `${encoded(iv)}.${encoded(ciphertext)}`; }
export async function decryptToken(value: string) { const [iv, ciphertext] = value.split("."); const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv) }, await cryptoKey(), bytes(ciphertext)); return new TextDecoder().decode(plain); }

export function authorizeUrl(origin: string, state: string) {
  const url = new URL(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", String(env.MS_CLIENT_ID)); url.searchParams.set("response_type", "code"); url.searchParams.set("redirect_uri", microsoftRedirect(origin));
  url.searchParams.set("response_mode", "query"); url.searchParams.set("scope", "offline_access User.Read Mail.Read Calendars.Read"); url.searchParams.set("state", state); return url.toString();
}

export async function exchangeCode(origin: string, code: string) {
  const body = new URLSearchParams({ client_id: String(env.MS_CLIENT_ID), client_secret: String(env.MS_CLIENT_SECRET), grant_type: "authorization_code", code, redirect_uri: microsoftRedirect(origin), scope: "offline_access User.Read Mail.Read Calendars.Read" });
  const response = await fetch(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json() as Record<string, unknown>; if (!response.ok) throw new Error(String(data.error_description || "Microsoft authorization failed.")); return data;
}

export async function refreshMicrosoft(refreshToken: string) {
  const body = new URLSearchParams({ client_id: String(env.MS_CLIENT_ID), client_secret: String(env.MS_CLIENT_SECRET), grant_type: "refresh_token", refresh_token: refreshToken, scope: "offline_access User.Read Mail.Read Calendars.Read" });
  const response = await fetch(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json() as Record<string, unknown>; if (!response.ok) throw new Error(String(data.error_description || "Microsoft token refresh failed.")); return data;
}

export async function graph(path: string, token: string) { const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } }); const data = await response.json() as Record<string, unknown>; if (!response.ok) throw new Error(String((data.error as { message?: string } | undefined)?.message || "Microsoft Graph request failed.")); return data; }
