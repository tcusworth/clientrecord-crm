import { env } from "cloudflare:workers";
import { audit, crmUser, userByEmail } from "@/lib/crm-auth";
import { canConnectOwn, oauthRedirect, oauthStateFromCookie, ownAccount, upsertPersonalAccount } from "@/lib/integrations/accounts";
import { exchangeCode, graph, encryptToken, microsoftConfigured } from "@/lib/microsoft";

export async function GET(request: Request) {
  // Every response clears the state cookie.
  const url = new URL(request.url), done = (result: string) => oauthRedirect(new URL(`/?integration=microsoft_${result}`, url.origin), "microsoft"), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  if (!microsoftConfigured() || !state || !code) return done("error");
  const valid = await env.DB.prepare("DELETE FROM oauth_states WHERE state=? AND expires_at>datetime('now') RETURNING actor_email AS actorEmail").bind(state).first<{ actorEmail: string }>();
  if (!valid) return done("expired");
  // The connection belongs to whoever started it, in the same browser (state cookie), so a forwarded authorize link
  // cannot bind someone else's mailbox to the actor. If an identity reaches this path it must be the actor too.
  const actor = await userByEmail(valid.actorEmail), session = await crmUser(request);
  if (!actor || !canConnectOwn(actor) || oauthStateFromCookie(request, "microsoft") !== state || (session && session.email.toLowerCase() !== actor.email)) return done("error");
  try {
    const token = await exchangeCode(url.origin, code), profile = await graph("/me?$select=mail,userPrincipalName", String(token.access_token));
    if (!token.refresh_token && !(await ownAccount("microsoft", actor.email))?.refresh_token) throw new Error("Microsoft did not return a refresh token and no existing refresh token is stored. Confirm the offline_access scope is granted and reconnect.");
    const accountEmail = String(profile.mail || profile.userPrincipalName || "");
    const id = await upsertPersonalAccount({ provider: "microsoft", userEmail: actor.email, accountEmail, accessTokenEnc: await encryptToken(String(token.access_token)), refreshTokenEnc: token.refresh_token ? await encryptToken(String(token.refresh_token)) : "", expiresAt: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(), scopes: String(token.scope || "") });
    await audit(actor, "integration.connect", "integration", id, "Connected Microsoft 365", { provider: "microsoft", userEmail: actor.email, accountEmail });
    return done("connected");
  } catch (error) { console.error(error); return done("error"); }
}
