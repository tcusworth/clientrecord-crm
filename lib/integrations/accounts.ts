import { env } from "cloudflare:workers";
import { can, type CRMUser } from "@/lib/crm-auth";

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
