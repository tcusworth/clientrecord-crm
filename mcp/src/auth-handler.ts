import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { userByEmail } from "@/lib/crm-auth";
import { CONNECTIONS_COOKIE, CONSENT_COOKIE, CONSENT_TTL_SECONDS, clearConsentCookie, connectionsPage, consentCookie, consentPage, escapeHtml, identify, readCookie } from "./consent";

export type AuthEnv = Omit<Cloudflare.Env, "OAUTH_PROVIDER"> & { OAUTH_PROVIDER: OAuthHelpers };
// form-action must also allow the client's redirect origin: Chrome applies form-action to the redirect that follows the POST.
const formSource = (redirectUri?: string) => { if (!redirectUri) return ""; try { const u = new URL(redirectUri); return u.protocol === "http:" || u.protocol === "https:" ? ` ${u.origin}` : ` ${u.protocol}`; } catch { return ""; } };
const html = (body: string, status = 200, headers: Record<string, string> = {}, redirectUri?: string) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formSource(redirectUri)}; frame-ancestors 'none'; base-uri 'none'`, ...headers } });
const denyPage = (message: string, status = 403) => html(`<!doctype html><title>Not allowed</title><p style="font:16px system-ui;max-width:560px;margin:48px auto">${escapeHtml(message)}</p>`, status);
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("");
const redirect = (location: string, status = 302, cookie = clearConsentCookie()) => new Response(null, { status, headers: { location, "cache-control": "no-store", "set-cookie": cookie } });
// Error back to the client. Only ever called with a redirect URI the library already validated against the registered client.
const errorRedirect = (redirectUri: string, error: string, state?: string, issuer?: string) => { const back = new URL(redirectUri); back.searchParams.set("error", error); if (state) back.searchParams.set("state", state); if (issuer) back.searchParams.set("iss", issuer); return redirect(back.toString()); };

const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return request.method === "POST" ? decide(request, env) : request.method === "GET" ? ask(request, env) : new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/connections") return connections(request, env);
    return new Response("Not found", { status: 404 });
  },
};
export default authHandler;

async function ask(request: Request, env: AuthEnv) {
  const person = await identify(request, env); if (!person) return denyPage("Sign in through Cloudflare Access to continue.", 401);
  const user = await userByEmail(person.email); if (!user) return denyPage("Your account doesn't have access to ClientRecord.");
  let authRequest: AuthRequest;
  try { authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request); }
  catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri) return errorRedirect(error.redirectUri, error.code, error.state, error.issuer);
    return denyPage(error instanceof AuthorizationError ? `This connection request is not valid (${error.description}). Remove the connector and add it again.` : "This connection request could not be checked. Try again.", 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId); if (!client) return denyPage("Unknown AI tool. Remove the connector and add it again.", 400);
  const consentId = randomId(), clientName = client.clientName || "AI tool";
  await env.OAUTH_KV.put(`consent:${consentId}`, JSON.stringify({ authRequest, email: user.email, clientName }), { expirationTtl: CONSENT_TTL_SECONDS });
  return html(consentPage({ clientName, redirectUri: authRequest.redirectUri, email: user.email, role: user.role, consentId }), 200, { "set-cookie": consentCookie(consentId) }, authRequest.redirectUri);
}

async function decide(request: Request, env: AuthEnv) {
  const person = await identify(request, env); if (!person) return denyPage("Sign in through Cloudflare Access to continue.", 401);
  const form = await request.formData(), consentId = String(form.get("consentId") || ""), decision = String(form.get("decision") || "");
  if (!consentId || readCookie(request, CONSENT_COOKIE) !== consentId) return denyPage("This approval page expired or was opened elsewhere. Start the connection again.", 400);
  const saved = await env.OAUTH_KV.get(`consent:${consentId}`, "json") as { authRequest: AuthRequest; email: string; clientName: string } | null;
  await env.OAUTH_KV.delete(`consent:${consentId}`);
  if (!saved || saved.email !== person.email) return denyPage("This approval page expired or belongs to someone else. Start the connection again.", 400);
  if (decision !== "allow") return errorRedirect(saved.authRequest.redirectUri, "access_denied", saved.authRequest.state, saved.authRequest.issuer);
  const user = await userByEmail(person.email); if (!user) return denyPage("Your account doesn't have access to ClientRecord.");
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: saved.authRequest, userId: user.email, metadata: { clientName: saved.clientName }, scope: saved.authRequest.scope, props: { email: user.email, clientName: saved.clientName } });
  return redirect(redirectTo);
}

async function connections(request: Request, env: AuthEnv) {
  const person = await identify(request, env); if (!person) return denyPage("Sign in through Cloudflare Access to continue.", 401);
  if (request.method === "POST") {
    const form = await request.formData(), token = String(form.get("token") || ""), grantId = String(form.get("grantId") || "");
    if (!token || token !== readCookie(request, CONNECTIONS_COOKIE)) return denyPage("This page expired. Reload it and try again.", 400);
    // revokeGrant is keyed by grant:<userId>:<grantId>, so it can only ever touch the signed-in person's own grants.
    if (/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) await env.OAUTH_PROVIDER.revokeGrant(grantId, person.email);
    return redirect("/connections", 303, clearConsentCookie(CONNECTIONS_COOKIE));
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const grants = (await env.OAUTH_PROVIDER.listUserGrants(person.email)).items.map(g => ({ id: g.id, clientName: String((g.metadata as { clientName?: string } | undefined)?.clientName || g.clientId), createdAt: g.createdAt })).sort((a, b) => b.createdAt - a.createdAt);
  const token = randomId();
  return html(connectionsPage({ email: person.email, grants, token }), 200, { "set-cookie": consentCookie(token, CONNECTIONS_COOKIE) });
}
