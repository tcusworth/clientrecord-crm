import { env } from "cloudflare:workers";
import { emitWebhook } from "@/lib/webhooks";

export type CRMRole = "owner" | "admin" | "editor" | "viewer";
export type CRMPermission = "records.view" | "records.edit" | "records.delete" | "records.export" | "campaigns.send" | "integrations.manage" | "settings.manage" | "audit.view" | "backups.manage" | "webhooks.manage" | "jobs.run";
export type CRMUser = { id: string; email: string; role: CRMRole; permissions: CRMPermission[] };

const rolePermissions: Record<CRMRole, CRMPermission[]> = {
  owner: ["records.view","records.edit","records.delete","records.export","campaigns.send","integrations.manage","settings.manage","audit.view","backups.manage","webhooks.manage","jobs.run"],
  admin: ["records.view","records.edit","records.delete","records.export","campaigns.send","integrations.manage","settings.manage","audit.view","backups.manage","webhooks.manage","jobs.run"],
  editor: ["records.view","records.edit","campaigns.send"],
  viewer: ["records.view"],
};

function parsePermissions(value: unknown, role: CRMRole) {
  try { const parsed = JSON.parse(String(value || "{}")); return Array.isArray(parsed) ? parsed as CRMPermission[] : rolePermissions[role]; }
  catch { return rolePermissions[role]; }
}

export async function crmUser(request: Request): Promise<CRMUser | null> {
  const hostname=new URL(request.url).hostname;if(hostname==="terminal.local"||hostname==="127.0.0.1"||hostname==="localhost")return {id:"local-preview",email:"tcusworth@gmail.com",role:"owner",permissions:rolePermissions.owner};
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
  if (!id || !email) return null;
  const owners = String(env.CRM_ALLOWED_EMAILS || "tcusworth@gmail.com").toLowerCase().split(",").map(v => v.trim()).filter(Boolean);
  if (owners.includes(email)) return { id, email, role: "owner", permissions: rolePermissions.owner };
  const member = await env.DB.prepare("SELECT role,permissions FROM team_members WHERE lower(email)=? AND active=1").bind(email).first<{ role: CRMRole; permissions: string }>();
  return member ? { id, email, role: member.role, permissions: parsePermissions(member.permissions, member.role) } : null;
}

export function canEdit(role: CRMRole) { return role === "owner" || role === "admin" || role === "editor"; }
export function canAdmin(role: CRMRole) { return role === "owner" || role === "admin"; }
export function can(user: CRMUser, permission: CRMPermission) { return user.role === "owner" || user.permissions.includes(permission); }

export function defaultPermissions(role: CRMRole) { return rolePermissions[role]; }

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2,"0")).join("");
}

export async function apiKeyUser(request: Request, requiredScope: string): Promise<CRMUser | null> {
  const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!raw?.startsWith("cr_live_")) return null;
  const hash = await sha256(raw);
  const row = await env.DB.prepare("SELECT id,scopes,created_by AS createdBy FROM api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>datetime('now'))").bind(hash).first<{id:string;scopes:string;createdBy:string}>();
  if (!row) return null;
  const scopes = String(row.scopes).split(",").map(v=>v.trim());
  if (!scopes.includes("*") && !scopes.includes(requiredScope)) return null;
  await env.DB.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?").bind(row.id).run();
  return { id:`api:${row.id}`, email:row.createdBy, role:"admin", permissions:rolePermissions.admin };
}

export async function audit(user: CRMUser, action: string, entityType: string, entityId: unknown, summary: string, changes: unknown = {}) {
  const safe = JSON.stringify(changes, (key, value) => /token|secret|html|body/i.test(key) ? "[redacted]" : value).slice(0, 32000);
  await env.DB.prepare("INSERT INTO audit_logs (actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
    .bind(user.email, action, entityType, entityId == null ? null : String(entityId), summary, safe).run();
  await emitWebhook(action, { actorEmail:user.email, entityType, entityId:entityId==null?null:String(entityId), summary, changes:JSON.parse(safe) });
}
