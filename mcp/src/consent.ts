import { verifiedCloudflareAccessIdentity } from "@/lib/cloudflare-access";

export const CONSENT_TTL_SECONDS = 600;
const COOKIE = "cr_consent";
export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

// Who is signing in. Production: a verified Cloudflare Access JWT only. Local dev: DEV_AUTHORIZE_AS, honoured only on localhost.
export async function identify(request: Request, env: { CF_ACCESS_TEAM_DOMAIN?: string; CF_ACCESS_AUD?: string; DEV_AUTHORIZE_AS?: string }): Promise<{ email: string } | null> {
  const host = new URL(request.url).hostname;
  if (env.DEV_AUTHORIZE_AS && (host === "localhost" || host === "127.0.0.1")) return { email: env.DEV_AUTHORIZE_AS.trim().toLowerCase() };
  const identity = await verifiedCloudflareAccessIdentity(request, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
  return identity ? { email: identity.email.trim().toLowerCase() } : null;
}

// The connections page uses its own cookie name so opening it never clobbers an in-flight consent.
export const CONSENT_COOKIE = COOKIE;
export const CONNECTIONS_COOKIE = "cr_connections";
export const consentCookie = (id: string, name = COOKIE) => `${name}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CONSENT_TTL_SECONDS}`;
export const clearConsentCookie = (name = COOKIE) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") || "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("=") || null; }
  return null;
}

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#0f172a}h1{font-size:22px}.card{border:1px solid #e2e8f0;border-radius:12px;padding:20px}.muted{color:#475569}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer}button.primary{background:#1d4ed8;color:#fff;border-color:#1d4ed8}ul{padding-left:20px}table{width:100%;border-collapse:collapse}td{padding:8px 0;border-top:1px solid #e2e8f0}</style></head><body>${body}</body></html>`;

export function consentPage(input: { clientName: string; redirectUri: string; email: string; role: string; consentId: string }): string {
  let host = ""; try { host = new URL(input.redirectUri).host; } catch { host = "(invalid redirect)"; }
  return shell("Connect an AI tool to ClientRecord", `<h1>Connect an AI tool to ClientRecord</h1><div class="card"><p><strong>${escapeHtml(input.clientName || "An AI tool")}</strong> wants to use your CRM as <strong>${escapeHtml(input.email)}</strong> (${escapeHtml(input.role)}).</p><p class="muted">After you allow it, you'll be sent back to <strong>${escapeHtml(host || input.redirectUri)}</strong>.</p><p>It will be able to:</p><ul><li>Search and read contacts, companies, deals, tasks and the pipeline you can see</li><li>Create and update contacts, companies, deals, notes, activities and tasks</li></ul><p>It <strong>cannot delete, merge, bulk-edit, send email or campaigns, see documents, or change settings</strong>. It never has more access than your own account.</p><form method="post" action="/authorize"><input type="hidden" name="consentId" value="${escapeHtml(input.consentId)}"><button class="primary" type="submit" name="decision" value="allow">Allow</button> <button type="submit" name="decision" value="deny">Deny</button></form></div><p class="muted">Manage connected tools at <a href="/connections">/connections</a>.</p>`);
}

export function connectionsPage(input: { email: string; grants: { id: string; clientName: string; createdAt: number }[]; token: string }): string {
  const rows = input.grants.map(g => `<tr><td><strong>${escapeHtml(g.clientName || "AI tool")}</strong><br><span class="muted">Connected ${escapeHtml(new Date(g.createdAt * 1000).toISOString().slice(0, 16).replace("T", " "))} UTC</span></td><td style="text-align:right"><form method="post" action="/connections"><input type="hidden" name="grantId" value="${escapeHtml(g.id)}"><input type="hidden" name="token" value="${escapeHtml(input.token)}"><button type="submit">Disconnect</button></form></td></tr>`).join("");
  return shell("Connected AI tools", `<h1>Connected AI tools</h1><p class="muted">Signed in as ${escapeHtml(input.email)}.</p><div class="card">${rows ? `<table>${rows}</table>` : "<p>No AI tools are connected.</p>"}</div>`);
}
