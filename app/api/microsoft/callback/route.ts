import { env } from "cloudflare:workers";
import { exchangeCode, graph, encryptToken, microsoftConfigured } from "@/lib/microsoft";

export async function GET(request: Request) {
  const url = new URL(request.url), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  if (!microsoftConfigured() || !state || !code) return Response.redirect(new URL("/?integration=microsoft_error", url.origin));
  const valid = await env.DB.prepare("SELECT actor_email AS actorEmail FROM oauth_states WHERE state=? AND expires_at>datetime('now')").bind(state).first<{ actorEmail: string }>();
  if (!valid) return Response.redirect(new URL("/?integration=microsoft_expired", url.origin));
  try {
    const token = await exchangeCode(url.origin, code), profile = await graph("/me?$select=mail,userPrincipalName", String(token.access_token));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO integration_accounts (provider,account_email,access_token,refresh_token,expires_at,scopes,created_at,updated_at) VALUES ('microsoft',?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(provider) DO UPDATE SET account_email=excluded.account_email,access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,scopes=excluded.scopes,updated_at=datetime('now')").bind(String(profile.mail || profile.userPrincipalName || ""), await encryptToken(String(token.access_token)), await encryptToken(String(token.refresh_token)), new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(), String(token.scope || "")),
      env.DB.prepare("DELETE FROM oauth_states WHERE state=?").bind(state),
      env.DB.prepare("INSERT INTO audit_logs (actor_email,action,entity_type,summary,changes,created_at) VALUES (?,'integration.connect','integration','Connected Microsoft 365','{}',datetime('now'))").bind(valid.actorEmail),
    ]);
    return Response.redirect(new URL("/?integration=microsoft_connected", url.origin));
  } catch (error) { console.error(error); return Response.redirect(new URL("/?integration=microsoft_error", url.origin)); }
}
