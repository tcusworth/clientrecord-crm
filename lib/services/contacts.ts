import { reconcileCompanyNames, reconcileCompanyNamesStatements } from "@/lib/crm-records";
import { ServiceError } from "@/lib/services/errors";

export type ContactInput = { firstName: string; lastName: string; email: string; company?: string; title?: string; phone?: string; location?: string; notes?: string; leadSource?: string; stage?: string; tags?: string[] };
const s = (v: unknown, fallback = "") => typeof v === "string" && v.trim() ? v.trim() : fallback;
const tagsJson = (tags?: string[]) => JSON.stringify((tags || []).map(t => String(t).trim()).filter(Boolean));
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));

export async function createContact(db: D1Database, input: ContactInput): Promise<{ id: number }> {
  const firstName = s(input.firstName), lastName = s(input.lastName), email = s(input.email).toLowerCase();
  if (!firstName || !lastName || !email) throw new ServiceError("Name and email are required.");
  if (await db.prepare("SELECT id FROM contacts WHERE lower(email)=?").bind(email).first()) throw new ServiceError("A contact with that email already exists.", 409);
  const suppressed = await db.prepare("SELECT reason FROM suppressions WHERE email=? AND removed_at IS NULL").bind(email).first<{ reason: string }>();
  const result = await db.prepare("INSERT INTO contacts (first_name,last_name,email,company,title,phone,location,notes,lead_source,stage,tags,subscribed,suppression_reason,suppressed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
    .bind(firstName, lastName, email, s(input.company), s(input.title), s(input.phone), s(input.location), s(input.notes), s(input.leadSource, "Direct"), s(input.stage, "Lead"), tagsJson(input.tags), suppressed ? 0 : 1, suppressed?.reason || null, suppressed ? new Date().toISOString() : null).run();
  await reconcileCompanyNames(db, [input.company]);
  return { id: Number(result.meta.last_row_id) };
}

export async function updateContact(db: D1Database, id: number, input: ContactInput, extra: D1PreparedStatement[] = []): Promise<void> {
  const email = s(input.email).toLowerCase(), stage = s(input.stage, "Lead");
  if (!id || !email) throw new ServiceError("Contact and email are required.");
  if (!(await db.prepare("SELECT id FROM contacts WHERE id=?").bind(id).first())) throw new ServiceError("Contact not found.", 404);
  await db.batch([db.prepare("UPDATE contacts SET first_name=?,last_name=?,email=?,company=?,title=?,phone=?,location=?,notes=?,lead_source=?,stage=?,tags=?,updated_at=datetime('now') WHERE id=?").bind(s(input.firstName), s(input.lastName), email, s(input.company), s(input.title), s(input.phone), s(input.location), s(input.notes), s(input.leadSource, "Direct"), stage, tagsJson(input.tags), id), ...extra, ...reconcileCompanyNamesStatements(db, [input.company])]);
  const matched = await db.prepare("SELECT s.id,(SELECT delay_days FROM automation_steps WHERE sequence_id=s.id ORDER BY step_order LIMIT 1) AS delayDays FROM automation_sequences s WHERE s.active=1 AND s.trigger_type='Contact stage' AND lower(s.trigger_value)=lower(?)").bind(stage).all();
  for (const sequence of matched.results) { const exists = await db.prepare("SELECT id FROM automation_enrollments WHERE sequence_id=? AND contact_id=? AND status='Active'").bind(sequence.id, id).first(); if (!exists) await db.prepare("INSERT INTO automation_enrollments (sequence_id,contact_id,current_step,status,next_run_at,enrolled_at) VALUES (?,?,0,'Active',datetime('now',?),datetime('now'))").bind(sequence.id, id, `+${Math.max(0, Number(sequence.delayDays) || 0)} days`).run(); }
}

export async function logContactActivity(db: D1Database, input: { contactId: number; type?: string; note: string; nextFollowUp?: string; owner: string; now?: string }): Promise<void> {
  const note = s(input.note), type = s(input.type, "Note"), now = input.now || new Date().toISOString(), next = s(input.nextFollowUp);
  if (!input.contactId || !note) throw new ServiceError("Contact and note are required.");
  if (!(await db.prepare("SELECT id FROM contacts WHERE id=?").bind(input.contactId).first())) throw new ServiceError("Contact not found.", 404);
  if (next && !isDate(next)) throw new ServiceError("Follow-up date must be YYYY-MM-DD.");
  const statements = [db.prepare("INSERT INTO activities (contact_id,type,note,happened_at) VALUES (?,?,?,?)").bind(input.contactId, type, note, now), db.prepare("UPDATE contacts SET last_contact=? WHERE id=?").bind(now.slice(0, 10), input.contactId)];
  if (next) statements.push(db.prepare("INSERT INTO tasks (contact_id,title,due_date,owner,status,completed) VALUES (?,?,?,?,'Open',0)").bind(input.contactId, "Follow up after " + type.toLowerCase(), next, input.owner), db.prepare("UPDATE contacts SET next_follow_up=? WHERE id=?").bind(next, input.contactId));
  await db.batch(statements);
}

export async function createContactTask(db: D1Database, input: { contactId: number; title: string; dueDate: string; owner: string }): Promise<{ id: number }> {
  const title = s(input.title), due = s(input.dueDate);
  if (!input.contactId || !title || !due) throw new ServiceError("Contact, task and due date are required.");
  if (!isDate(due)) throw new ServiceError("Due date must be YYYY-MM-DD.");
  if (!(await db.prepare("SELECT id FROM contacts WHERE id=?").bind(input.contactId).first())) throw new ServiceError("Contact not found.", 404);
  const [created] = await db.batch([db.prepare("INSERT INTO tasks (contact_id,title,due_date,owner,status,completed) VALUES (?,?,?,?,'Open',0)").bind(input.contactId, title, due, input.owner), db.prepare("UPDATE contacts SET next_follow_up=? WHERE id=?").bind(due, input.contactId)]);
  return { id: Number(created.meta.last_row_id) };
}

export async function completeContactTask(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("UPDATE tasks SET completed=1,status='Completed' WHERE id=?").bind(id).run();
  return Number(result.meta.changes || 0) > 0;
}
