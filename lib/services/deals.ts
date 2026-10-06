import { defaultPipeline, type Pipeline } from "@/lib/sales-rules";
import { ServiceError } from "@/lib/services/errors";

type Row = Record<string, unknown>;
export type DealInput = { id?: number; name: string; owner: string; pipeline_key: string; stage_key: string; value?: number; contact_id?: number | null; company_id?: number | null; company?: string; close_date?: string; next_step?: string; closed_reason?: string; lead_source?: string; campaign?: string; partner?: string; forecast_category?: string };
const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
const s = (v: unknown, max = 4000) => String(v ?? "").trim().slice(0, max);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const need = (v: unknown, label: string) => { const t = str(v); if (!t || t.length > 4000) throw new ServiceError(label + " is required (maximum 4,000 characters)."); return t; };

export async function pipelines(db: D1Database): Promise<Pipeline[]> {
  const saved = (await db.prepare("SELECT * FROM sales_pipelines ORDER BY name").all<Row>()).results;
  const list = saved.map(r => ({ id: String(r.id), name: String(r.name), stages: JSON.parse(String(r.stages)) }));
  return list.some(p => p.id === "default") ? list : [defaultPipeline, ...list];
}

export async function dealRecord(db: D1Database, dealId: number): Promise<Row> {
  const deal = await db.prepare("SELECT d.*,COALESCE(d.company_id,c.id) AS resolved_company_id FROM deals d LEFT JOIN companies c ON c.name=d.company WHERE d.id=?").bind(dealId).first<Row>();
  if (!deal) throw new ServiceError("Deal not found.", 404);
  return deal;
}

export async function saveDeal(db: D1Database, input: DealInput, actor: string, now = new Date().toISOString()): Promise<{ id: number; before: Row | null; changed: boolean }> {
  const id = input.id ? Number(input.id) : 0, before = id ? await db.prepare("SELECT * FROM deals WHERE id=?").bind(id).first<Row>() : null;
  if (id && !before) throw new ServiceError("Deal not found.", 404);
  const pipe = (await pipelines(db)).find(p => p.id === str(input.pipeline_key)), stage = pipe?.stages.find(st => st.key === str(input.stage_key));
  if (!pipe || !stage) throw new ServiceError("Choose a pipeline and one of its stages.");
  const name = need(input.name, "Deal name"), owner = need(input.owner, "Owner"), reason = str(input.closed_reason), next = str(input.next_step);
  if (stage.kind !== "Open" && !reason) throw new ServiceError("A won/lost reason is required.");
  if (stage.kind === "Open" && !next) throw new ServiceError("Open deals need a next action.");
  const dollars = input.value === undefined ? 0 : Number(input.value); if (!Number.isFinite(dollars) || dollars < 0 || dollars > 1e10) throw new ServiceError("A numeric value is out of range.");
  const value = Math.round(dollars * 100), contact = input.contact_id ? Number(input.contact_id) : null;
  let companyId = input.company_id ? Number(input.company_id) : null, company: { id?: number; name: string } | null = companyId ? await db.prepare("SELECT name FROM companies WHERE id=?").bind(companyId).first<{ name: string }>() : null;
  // Preserve compatibility with older clients while converting the stored name into a durable relationship.
  if (!companyId && str(input.company)) { company = await db.prepare("SELECT id,name FROM companies WHERE lower(name)=lower(?) LIMIT 1").bind(str(input.company)).first<{ id: number; name: string }>(); if (company) companyId = company.id ?? null; }
  if (companyId && !company) throw new ServiceError("Choose an existing company record.");
  if (companyId && contact && !(await db.prepare("SELECT c.id FROM contacts c WHERE c.id=? AND (lower(trim(coalesce(c.company,'')))=lower(trim(?)) OR EXISTS (SELECT 1 FROM account_stakeholders s WHERE s.company_id=? AND s.contact_id=c.id)) LIMIT 1").bind(contact, company!.name, companyId).first())) throw new ServiceError("Choose a contact associated with the selected company.");
  const required = stage.requiredFields || [];
  if (required.includes("company") && !companyId) throw new ServiceError(`${stage.name} requires a company.`);
  if (required.includes("contact") && !contact) throw new ServiceError(`${stage.name} requires a primary contact.`);
  if (required.includes("value") && !value) throw new ServiceError(`${stage.name} requires a deal value.`);
  if (required.includes("closeDate") && !str(input.close_date)) throw new ServiceError(`${stage.name} requires an expected close date.`);
  if (required.includes("nextStep") && !next) throw new ServiceError(`${stage.name} requires a next action.`);
  if (required.includes("products") && (!id || !(await db.prepare("SELECT id FROM deal_line_items WHERE deal_id=? LIMIT 1").bind(id).first()))) throw new ServiceError(`${stage.name} requires at least one product or line item. Save the deal in an earlier stage, add products, then advance it.`);
  if (required.includes("decisionCriteria") && (!id || !(await db.prepare("SELECT id FROM deal_insights WHERE deal_id=? AND kind='Decision criterion' LIMIT 1").bind(id).first()))) throw new ServiceError(`${stage.name} requires documented decision criteria.`);
  if (required.includes("approval") && (!id || !(await db.prepare("SELECT id FROM deal_reviews WHERE deal_id=? AND status='Approved' LIMIT 1").bind(id).first()))) throw new ServiceError(`${stage.name} requires an approved deal review.`);
  const changed = !before || before.pipeline_key !== pipe.id || (before.stage_key || before.stage) !== stage.key;
  const params = [name, company?.name || "", companyId, contact, stage.name, owner, value, stage.probability, next, str(input.close_date) || null, str(input.lead_source) || "Direct", str(input.campaign), str(input.partner), str(input.forecast_category) || "Pipeline", stage.kind, pipe.id, stage.key, stage.kind === "Open" ? "" : reason, changed ? now : String(before?.stage_entered_at || ""), now];
  const mutation = id ? db.prepare("UPDATE deals SET name=?,company=?,company_id=?,contact_id=?,stage=?,owner=?,value=?,probability=?,next_step=?,close_date=?,lead_source=?,campaign=?,partner=?,forecast_category=?,status=?,pipeline_key=?,stage_key=?,closed_reason=?,stage_entered_at=?,updated_at=? WHERE id=?").bind(...params, id) : db.prepare("INSERT INTO deals(name,company,company_id,contact_id,stage,owner,value,probability,next_step,close_date,lead_source,campaign,partner,forecast_category,status,pipeline_key,stage_key,closed_reason,stage_entered_at,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...params, now);
  // last_insert_rowid refers to the preceding deal insert inside this transaction.
  const history = db.prepare("INSERT INTO deal_stage_history(deal_id,from_stage,to_stage,from_pipeline,to_pipeline,reason,actor,happened_at) VALUES (" + (id ? "?" : "last_insert_rowid()") + ",?,?,?,?,?,?,?)").bind(...(id ? [id] : []), String(before?.stage || "Created"), stage.name, String(before?.pipeline_key || ""), pipe.id, reason, actor, now);
  const [written] = await db.batch([mutation, ...(changed ? [history] : [])]);
  const savedId = id || Number(written?.meta.last_row_id);
  if (changed && contact) await db.prepare("INSERT INTO automation_enrollments(sequence_id,contact_id,current_step,status,next_run_at,enrolled_at) SELECT s.id,?,0,'Active',datetime('now','+'||COALESCE((SELECT delay_days FROM automation_steps WHERE sequence_id=s.id ORDER BY step_order LIMIT 1),0)||' days'),? FROM automation_sequences s WHERE s.active=1 AND s.trigger_type='Deal stage' AND lower(s.trigger_value)=lower(?) AND NOT EXISTS(SELECT 1 FROM automation_enrollments e WHERE e.sequence_id=s.id AND e.contact_id=? AND e.status='Active')").bind(contact, now, stage.name, contact).run();
  return { id: savedId, before, changed };
}

export async function addDealNote(db: D1Database, input: { dealId: number; body: string; kind?: string; pinned?: boolean; owner: string; now?: string }): Promise<{ id: number }> {
  const content = s(input.body), now = input.now || new Date().toISOString(); if (!content) throw new ServiceError("Enter a note or comment.");
  await dealRecord(db, input.dealId);
  const result = await db.prepare("INSERT INTO deal_notes(deal_id,kind,body,owner,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(input.dealId, s(input.kind, 30) || "Note", content, input.owner, input.pinned ? 1 : 0, now, now).run();
  return { id: Number(result.meta.last_row_id) };
}

export async function logDealActivity(db: D1Database, input: { dealId: number; type: string; body: string; subject?: string; outcome?: string; happenedAt?: string; followUpAt?: string; followUpTitle?: string; contactId?: number | null; owner: string; responseExpected?: boolean; pinned?: boolean; threadKey?: string; now?: string }): Promise<{ id: number; contactId: number | null; followUpAt: string | null }> {
  const now = input.now || new Date().toISOString(), type = s(input.type, 50), content = s(input.body), happened = s(input.happenedAt, 40) || now;
  if (!type || !content || !Number.isFinite(Date.parse(happened))) throw new ServiceError("Activity type, details, and a valid date are required.");
  const deal = await dealRecord(db, input.dealId), contactId = input.contactId ? Number(input.contactId) : deal.contact_id ? Number(deal.contact_id) : null, follow = s(input.followUpAt, 20) || null;
  const result = await db.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,follow_up_at,source,thread_key,external_id,response_expected,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(input.dealId, deal.resolved_company_id ? Number(deal.resolved_company_id) : null, contactId, type, s(input.subject, 240), content, s(input.owner, 200), s(input.outcome, 1000), new Date(happened).toISOString(), follow, "Manual", s(input.threadKey, 240) || null, null, input.responseExpected ? 1 : 0, input.pinned ? 1 : 0, now, now).run();
  if (follow) await db.prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,created_at) VALUES (?,?,?,?,?)").bind(input.dealId, s(input.followUpTitle, 240) || `Follow up: ${s(input.subject, 180) || type}`, s(input.owner, 200), follow.slice(0, 10), now).run();
  return { id: Number(result.meta.last_row_id), contactId, followUpAt: follow };
}

export async function createDealTask(db: D1Database, input: { dealId: number; title: string; owner: string; dueDate: string; now?: string }): Promise<{ id: number }> {
  const due = need(input.dueDate, "Due date"); if (!isDate(due)) throw new ServiceError("Choose a valid due date.");
  await dealRecord(db, input.dealId);
  const result = await db.prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,created_at) VALUES (?,?,?,?,?)").bind(input.dealId, need(input.title, "Task title"), need(input.owner, "Task owner"), due, input.now || new Date().toISOString()).run();
  return { id: Number(result.meta.last_row_id) };
}

export async function setDealTaskCompleted(db: D1Database, id: number, completed: boolean): Promise<boolean> {
  const result = await db.prepare("UPDATE deal_tasks SET completed=? WHERE id=?").bind(completed ? 1 : 0, id).run();
  return Number(result.meta.changes || 0) > 0;
}
