import { env } from "cloudflare:workers";
import { exchangeCode, graph, encryptToken, microsoftConfigured } from "@/lib/microsoft";

export async function GET(request: Request) {
  const url = new URL(request.url), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  if (!microsoftConfigured() || !state || !code) return Response.redirect(new URL("/?integration=microsoft_error", url.origin));
  const valid = await env.DB.prepare("DELETE FROM oauth_states WHERE state=? AND expires_at>datetime('now') RETURNING actor_email AS actorEmail").bind(state).first<{ actorEmail: string }>();
  if (!valid) return Response.redirect(new URL("/?integration=microsoft_expired", url.origin));
  try {
    const token = await exchangeCode(url.origin, code), profile = await graph("/me?$select=mail,userPrincipalName", String(token.access_token));
    if (!token.refresh_token && !(await env.DB.prepare("SELECT refresh_token FROM integration_accounts WHERE provider='microsoft' AND refresh_token<>''").first())) throw new Error("Microsoft did not return a refresh token and no existing refresh token is stored. Confirm the offline_access scope is granted and reconnect.");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO integration_accounts (provider,account_email,access_token,refresh_token,expires_at,scopes,created_at,updated_at) VALUES ('microsoft',?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(provider) DO UPDATE SET account_email=excluded.account_email,access_token=excluded.access_token,refresh_token=CASE WHEN excluded.refresh_token='' THEN integration_accounts.refresh_token ELSE excluded.refresh_token END,expires_at=excluded.expires_at,scopes=excluded.scopes,updated_at=datetime('now')").bind(String(profile.mail || profile.userPrincipalName || ""), await encryptToken(String(token.access_token)), token.refresh_token ? await encryptToken(String(token.refresh_token)) : "", new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(), String(token.scope || "")),
      env.DB.prepare("INSERT INTO audit_logs (actor_email,action,entity_type,summary,changes,created_at) VALUES (?,'integration.connect','integration','Connected Microsoft 365','{}',datetime('now'))").bind(valid.actorEmail),
    ]);
    return Response.redirect(new URL("/?integration=microsoft_connected", url.origin));
  } catch (error) { console.error(error); return Response.redirect(new URL("/?integration=microsoft_error", url.origin)); }
}
