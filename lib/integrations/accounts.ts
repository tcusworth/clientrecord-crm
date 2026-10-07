import { env } from "cloudflare:workers";
import { can, userByEmail, type CRMUser } from "@/lib/crm-auth";

export type Provider = "microsoft" | "google";
export type IntegrationAccount = { id: number; provider: Provider; user_email: string; account_email: string; access_token: string; refresh_token: string; expires_at: string; scopes: string; sync_email: number; sync_calendar: number; auto_tasks: number; last_synced_at: string | null; status: string };
const COLUMNS = "id,provider,user_email,account_email,access_token,refresh_token,expires_at,scopes,sync_email,sync_calendar,auto_tasks,last_synced_at,status";

// Connect / sync / disconnect your OWN Google or Microsoft account.
export function canConnectOwn(user: CRMUser) { return can(user, "records.edit"); }
// See every personal connection and disconnect anyone's.
export function canManageAll(user: CRMUser) { return can(user, "integrations.manage"); }

export async function ownAccount(provider: Provider, email: string) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM integration_accounts WHERE provider=? AND user_email=?`).bind(provider, String(email || "").trim().toLowerCase()).first<IntegrationAccount>();
}
export async function accountById(id: number) { return env.DB.prepare(`SELECT ${COLUMNS} FROM integration_accounts WHERE id=?`).bind(id).first<IntegrationAccount>(); }
export async function allPersonalAccounts() {
  return (await env.DB.prepare(`SELECT ${COLUMNS} FROM integration_accounts WHERE provider IN ('google','microsoft') ORDER BY provider,user_email`).all<IntegrationAccount>()).results;
}

// One row per (provider, CRM user). A blank refresh token keeps the stored one; reconnecting clears needs_reconnect.
export async function upsertPersonalAccount(input: { provider: Provider; userEmail: string; accountEmail: string; accessTokenEnc: string; refreshTokenEnc: string; expiresAt: string; scopes: string }) {
  const row = await env.DB.prepare("INSERT INTO integration_accounts (provider,user_email,account_email,access_token,refresh_token,expires_at,scopes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'connected',datetime('now'),datetime('now')) ON CONFLICT(provider,user_email) DO UPDATE SET account_email=excluded.account_email,access_token=excluded.access_token,refresh_token=CASE WHEN excluded.refresh_token='' THEN integration_accounts.refresh_token ELSE excluded.refresh_token END,expires_at=excluded.expires_at,scopes=excluded.scopes,status='connected',updated_at=datetime('now') RETURNING id")
    .bind(input.provider, input.userEmail.trim().toLowerCase(), input.accountEmail, input.accessTokenEnc, input.refreshTokenEnc, input.expiresAt, input.scopes).first<{ id: number }>();
  return Number(row?.id);
}

// Sync helpers shared by microsoft-sync and google-sync.
export type SyncResult = { accountId: number; emails: number; events: number; skipped: number; reviewQueued: number };
// The account's tokens no longer work (or its owner left the CRM): the owner must reconnect.
export class ReconnectRequired extends Error {}
export async function needsReconnect(id: number, message: string): Promise<never> {
  await env.DB.prepare("UPDATE integration_accounts SET status='needs_reconnect',updated_at=datetime('now') WHERE id=?").bind(id).run();
  throw new ReconnectRequired(message);
}
// Sync runs as the mailbox owner; an account whose owner is no longer an active CRM member is flagged instead.
export async function syncOwner(account: IntegrationAccount) {
  return await userByEmail(account.user_email) || needsReconnect(account.id, `${account.user_email} is no longer an active CRM member; reconnect required.`);
}
// Token endpoint said the grant is gone (invalid_grant) or refused us outright (401).
export const grantRejected = (error: unknown) => { const e = error as { code?: string; status?: number } | null; return e?.code === "invalid_grant" || e?.status === 401; };
export const unauthorized = (error: unknown) => (error as { status?: number } | null)?.status === 401;
export async function markSynced(id: number) { await env.DB.prepare("UPDATE integration_accounts SET last_synced_at=datetime('now'),status='connected',updated_at=datetime('now') WHERE id=?").bind(id).run(); }

// Browser binding for the OAuth round trip: connect sets a short-lived cookie holding the state, the callback requires it.
// Lax so it rides the top-level redirect back from the provider; the callback path bypasses Cloudflare Access.
const stateCookie = (provider: Provider) => `__Host-cr_oauth_${provider}`;
export function oauthRedirect(location: URL | string, provider: Provider, state = "") {
  return new Response(null, { status: 302, headers: { location: String(location), "set-cookie": `${stateCookie(provider)}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${state ? 600 : 0}` } });
}
export function oauthStateFromCookie(request: Request, provider: Provider) {
  const name = `${stateCookie(provider)}=`;
  return (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(name))?.slice(name.length) || "";
}
