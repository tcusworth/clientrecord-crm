import { ServiceError } from "@/lib/services/errors";

type Row = Record<string, unknown>;
export type CompanyInput = { name: string; owner: string; stage?: string; notes?: string; website?: string; domain?: string; industry?: string; tier?: string; territory?: string; tags?: string[]; fit_score?: number; fit_reason?: string; summary?: string; headquarters?: string; linkedin_url?: string; logo_url?: string; employee_range?: string; primary_contact_id?: number | null };
const s = (v: unknown) => typeof v === "string" ? v.trim() : "";
const NOTES_MAX = 20000;

// Each recalculation runs in the same transaction as its source edit.
export function recalculateCompany(db: D1Database, id: number | string, actor: string): D1PreparedStatement[] {
  const selector = typeof id === "number" ? "id=?" : "name=?";
  const intent = "MAX(0,MIN(100,COALESCE((SELECT SUM(points) FROM account_signals WHERE company_id=companies.id AND active=1),0)))";
  const temperature = "CASE WHEN " + intent + ">=60 AND fit_score>=50 THEN 'Hot' WHEN " + intent + ">=20 THEN 'Lukewarm' ELSE 'Cold' END";
  return [
    db.prepare("INSERT INTO qualification_alerts(company_id,owner,message,created_at) SELECT id,CASE WHEN owner='' THEN ? ELSE owner END,name||': '||temperature||' → '||(" + temperature + "),? FROM companies WHERE " + selector + " AND temperature<>(" + temperature + ")").bind(actor, new Date().toISOString(), id),
    db.prepare("UPDATE companies SET intent_score=" + intent + ",temperature=" + temperature + " WHERE " + selector).bind(id),
  ];
}

export async function saveCompany(db: D1Database, input: CompanyInput, actor: string, now = new Date().toISOString()): Promise<{ id: number; before: Row | null }> {
  const name = s(input.name), owner = s(input.owner).toLowerCase(), fit = Number(input.fit_score ?? 0), website = s(input.website);
  if (!name || name.length > 4000) throw new ServiceError("Company name is required (maximum 4,000 characters).");
  if (!owner || owner.length > 4000) throw new ServiceError("Owner email is required (maximum 4,000 characters).");
  if (!Number.isFinite(fit) || fit < 0 || fit > 100) throw new ServiceError("A numeric value is out of range.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) throw new ServiceError("Use an email address for the account owner.");
  if (website && !/^https?:\/\//i.test(website)) throw new ServiceError("Website must start with https:// or http://.");
  if (fit > 0 && !s(input.fit_reason)) throw new ServiceError("Explain the fit score so qualification remains transparent.");
  const before = await db.prepare("SELECT * FROM companies WHERE name=?").bind(name).first<Row>();
  const tags = JSON.stringify((input.tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 30));
  const domain = s(input.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  const result = await db.batch([
    db.prepare("INSERT INTO companies(name,stage,notes,updated_at,website,domain,industry,tier,territory,owner,tags,fit_score,fit_reason,summary,headquarters,linkedin_url,logo_url,employee_range) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET stage=excluded.stage,notes=excluded.notes,updated_at=excluded.updated_at,website=excluded.website,domain=excluded.domain,industry=excluded.industry,tier=excluded.tier,territory=excluded.territory,owner=excluded.owner,tags=excluded.tags,fit_score=excluded.fit_score,fit_reason=excluded.fit_reason,summary=excluded.summary,headquarters=excluded.headquarters,linkedin_url=excluded.linkedin_url,logo_url=excluded.logo_url,employee_range=excluded.employee_range")
      .bind(name, s(input.stage) || "Prospect", s(input.notes), now, website, domain, s(input.industry), s(input.tier), s(input.territory), owner, tags, fit, s(input.fit_reason), s(input.summary), s(input.headquarters), s(input.linkedin_url), s(input.logo_url), s(input.employee_range)),
    ...(input.primary_contact_id !== undefined ? [db.prepare("UPDATE companies SET primary_contact_id=? WHERE name=?").bind(input.primary_contact_id || null, name)] : []),
    ...recalculateCompany(db, name, actor),
  ]);
  return { id: before ? Number(before.id) : Number(result[0].meta.last_row_id), before };
}

export async function appendCompanyNote(db: D1Database, companyId: number, note: string, author: string, now = new Date().toISOString()): Promise<void> {
  const text = s(note); if (!text) throw new ServiceError("Enter a note.");
  const company = await db.prepare("SELECT notes FROM companies WHERE id=?").bind(companyId).first<{ notes: string }>();
  if (!company) throw new ServiceError("Company not found.", 404);
  const next = [s(company.notes), `[${now.slice(0, 10)} ${author}] ${text}`].filter(Boolean).join("\n");
  if (next.length > NOTES_MAX) throw new ServiceError("Company notes are full (20,000 characters). Trim older notes in the CRM first.");
  await db.prepare("UPDATE companies SET notes=?,updated_at=? WHERE id=?").bind(next, now, companyId).run();
}
