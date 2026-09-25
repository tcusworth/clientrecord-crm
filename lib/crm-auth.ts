import { env } from "cloudflare:workers";
import { emitWebhook } from "@/lib/webhooks";
import { verifiedCloudflareAccessIdentity } from "@/lib/cloudflare-access";

export type CRMRole = "owner" | "admin" | "editor" | "viewer";
export type CRMPermission = "records.view" | "records.edit" | "records.delete" | "records.export" | "documents.view" | "documents.upload" | "documents.manage_sensitive" | "campaigns.send" | "integrations.manage" | "settings.manage" | "audit.view" | "backups.manage" | "webhooks.manage" | "jobs.run" | "ai.view" | "ai.generate" | "ai.review" | "ai.configure";
export type CRMUser = { id: string; email: string; role: CRMRole; permissions: CRMPermission[] };

const rolePermissions: Record<CRMRole, CRMPermission[]> = {
  owner: ["records.view","records.edit","records.delete","records.export","documents.view","documents.upload","documents.manage_sensitive","campaigns.send","integrations.manage","settings.manage","audit.view","backups.manage","webhooks.manage","jobs.run","ai.view","ai.generate","ai.review","ai.configure"],
  admin: ["records.view","records.edit","records.delete","records.export","documents.view","documents.upload","documents.manage_sensitive","campaigns.send","integrations.manage","settings.manage","audit.view","backups.manage","webhooks.manage","jobs.run","ai.view","ai.generate","ai.review","ai.configure"],
  editor: ["records.view","records.edit","documents.view","documents.upload","campaigns.send","ai.view","ai.generate","ai.review"],
  viewer: ["records.view","documents.view","ai.view"],
};

// Fallback owner when CRM_ALLOWED_EMAILS is unset (also used for the Vite dev-server preview identity).
export const DEFAULT_OWNER_EMAIL = "tcusworth@gmail.com";

// API keys never inherit a human role: each scope grants only the permissions listed here.
export const API_KEY_SCOPE_PERMISSIONS: Record<string, CRMPermission[]> = {
  "records.read": ["records.view"],
  "records.write": ["records.view","records.edit"],
  "leads.capture": ["records.view","records.edit"],
  "inbox.capture": ["records.view","records.edit"],
  "meetings.import": ["records.view","records.edit"],
  "jobs.run": ["jobs.run"],
  // Full data export (/api/backup-export). Checked by scope, so it grants no other permission.
  "backups.export": [],
};
export const API_KEY_SCOPES = [...Object.keys(API_KEY_SCOPE_PERMISSIONS), "*"];
// Scopes only an owner may put on a new key.
export const OWNER_ONLY_API_KEY_SCOPES = ["*", "backups.export"];
export function apiKeyPermissions(scopes: string[]): CRMPermission[] {
  const keys = scopes.includes("*") ? Object.keys(API_KEY_SCOPE_PERMISSIONS) : scopes;
  return Array.from(new Set(keys.flatMap(scope => API_KEY_SCOPE_PERMISSIONS[scope] || [])));
}

function parsePermissions(value: unknown, role: CRMRole) {
  try { const parsed = JSON.parse(String(value || "{}")); return Array.isArray(parsed) ? parsed as CRMPermission[] : rolePermissions[role]; }
  catch { return rolePermissions[role]; }
}

export async function crmUser(request: Request): Promise<CRMUser | null> {
  // Local preview bypass only under the Vite dev server: @cloudflare/vite-plugin statically replaces
  // process.env.NODE_ENV in worker code ("production" for `vite build`), so this is dead code in deployed builds.
  if(process.env.NODE_ENV==="development"){const hostname=new URL(request.url).hostname;if(hostname==="terminal.local"||hostname==="127.0.0.1"||hostname==="localhost")return {id:"local-preview",email:DEFAULT_OWNER_EMAIL,role:"owner",permissions:rolePermissions.owner};}
  const accessIdentity = await verifiedCloudflareAccessIdentity(request, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
  let id = accessIdentity?.id;
  let email = accessIdentity?.email;

  // Platform identity headers (oai-authenticated-*, injected by OpenAI Sites) are spoofable by anyone who can reach
  // the origin directly, so they are opt-in: trusted only when TRUST_PLATFORM_IDENTITY_HEADERS is exactly "true" AND
  // either Cloudflare Access is not configured, or Access is configured but CF_ACCESS_ENFORCED is explicitly "false"
  // (staged-rollout escape hatch). CF_ACCESS_ENFORCED=true always rejects. Otherwise only a verified Access JWT counts.
  if (!id || !email) {
    if (String(env.TRUST_PLATFORM_IDENTITY_HEADERS || "").trim() !== "true") return null;
    const enforced = String(env.CF_ACCESS_ENFORCED || "").trim().toLowerCase(), accessConfigured = Boolean(String(env.CF_ACCESS_TEAM_DOMAIN || "").trim() && String(env.CF_ACCESS_AUD || "").trim());
    if (enforced === "true" || (accessConfigured && enforced !== "false")) return null;
    id = request.headers.get("oai-authenticated-user-id") || undefined;
    email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  }
  if (!id || !email) return null;
  const owners = String(env.CRM_ALLOWED_EMAILS || DEFAULT_OWNER_EMAIL).toLowerCase().split(",").map(v => v.trim()).filter(Boolean);
  if (owners.includes(email)) return { id, email, role: "owner", permissions: rolePermissions.owner };
  const member = await env.DB.prepare("SELECT role,permissions FROM team_members WHERE lower(email)=? AND active=1").bind(email).first<{ role: CRMRole; permissions: string }>();
  return member ? { id, email, role: member.role, permissions: parsePermissions(member.permissions, member.role) } : null;
}

export function canEdit(role: CRMRole) { return role === "owner" || role === "admin" || role === "editor"; }
export function canAdmin(role: CRMRole) { return role === "owner" || role === "admin"; }
export function can(user: CRMUser, permission: CRMPermission) { return user.role === "owner" || user.permissions.includes(permission); }

// Display name for task ownership: team_members.name when set, otherwise the sign-in email.
export async function displayName(user: { email: string }) {
  const member = await env.DB.prepare("SELECT name FROM team_members WHERE lower(email)=lower(?)").bind(user.email).first<{ name: string }>();
  return String(member?.name || "").trim() || user.email;
}

export function defaultPermissions(role: CRMRole) { return rolePermissions[role]; }

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2,"0")).join("");
}

// allowWildcard:false requires the scope to be listed explicitly ("*" keys do not satisfy it).
export async function apiKeyUser(request: Request, requiredScope: string, { allowWildcard = true } = {}): Promise<CRMUser | null> {
  const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!raw?.startsWith("cr_live_")) return null;
  const hash = await sha256(raw);
  const row = await env.DB.prepare("SELECT id,scopes,created_by AS createdBy FROM api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>datetime('now'))").bind(hash).first<{id:string;scopes:string;createdBy:string}>();
  if (!row) return null;
  const scopes = String(row.scopes).split(",").map(v=>v.trim());
  if (!(allowWildcard && scopes.includes("*")) && !scopes.includes(requiredScope)) return null;
  await env.DB.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?").bind(row.id).run();
  const permissions = apiKeyPermissions(scopes);
  return { id:`api:${row.id}`, email:row.createdBy, role:permissions.includes("records.edit") ? "editor" : "viewer", permissions };
}

function safeAuditChanges(changes: unknown) {
  const serialized = JSON.stringify(changes, (key, value) => /token|secret|html|body/i.test(key) ? "[redacted]" : value);
  if (serialized.length <= 32000) return { serialized, value:JSON.parse(serialized) as unknown };

  const source = changes && typeof changes === "object" && !Array.isArray(changes)
    ? changes as Record<string, unknown>
    : {};
  const shape = Object.fromEntries(Object.entries(source).slice(0, 50).map(([key, value]) => [
    key.slice(0, 100),
    Array.isArray(value)
      ? { type:"array", count:value.length }
      : value === null
        ? { type:"null" }
        : { type:typeof value },
  ]));
  const value = {
    truncated:true,
    originalCharacters:serialized.length,
    action:typeof source.action === "string" ? source.action.slice(0, 200) : undefined,
    filename:typeof source.filename === "string" ? source.filename.slice(0, 500) : undefined,
    recordCount:Array.isArray(source.contacts) ? source.contacts.length : undefined,
    shape,
  };
  return { serialized:JSON.stringify(value), value };
}

export async function audit(user: CRMUser, action: string, entityType: string, entityId: unknown, summary: string, changes: unknown = {}) {
  const safe = safeAuditChanges(changes);
  await env.DB.prepare("INSERT INTO audit_logs (actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES (?,?,?,?,?,?,datetime('now'))")
    .bind(user.email, action, entityType, entityId == null ? null : String(entityId), summary, safe.serialized).run();
  await emitWebhook(action, { actorEmail:user.email, entityType, entityId:entityId==null?null:String(entityId), summary, changes:safe.value });
}
