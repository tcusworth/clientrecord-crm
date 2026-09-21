import { env } from "cloudflare:workers";

export type CRMRole = "owner" | "admin" | "editor" | "viewer";
export type CRMUser = { id: string; email: string; role: CRMRole };

export async function crmUser(request: Request): Promise<CRMUser | null> {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
  if (!id || !email) return null;
  const owners = String(env.CRM_ALLOWED_EMAILS || "tcusworth@gmail.com").toLowerCase().split(",").map(v => v.trim()).filter(Boolean);
  if (owners.includes(email)) return { id, email, role: "owner" };
  const member = await env.DB.prepare("SELECT role FROM team_members WHERE lower(email)=? AND active=1").bind(email).first<{ role: CRMRole }>();
  return member ? { id, email, role: member.role } : null;
}

export function canEdit(role: CRMRole) { return role === "owner" || role === "admin" || role === "editor"; }
export function canAdmin(role: CRMRole) { return role === "owner" || role === "admin"; }

export async function audit(user: CRMUser, action: string, entityType: string, entityId: unknown, summary: string, changes: unknown = {}) {
  const safe = JSON.stringify(changes, (key, value) => /token|secret|html|body/i.test(key) ? "[redacted]" : value).slice(0, 8000);
  await env.DB.prepare("INSERT INTO audit_logs (actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
    .bind(user.email, action, entityType, entityId == null ? null : String(entityId), summary, safe).run();
}
