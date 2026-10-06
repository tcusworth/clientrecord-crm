type Row = Record<string, unknown>;
const cap = (n: unknown, max = 25, fallback = 25) => Math.max(1, Math.min(max, Number(n) || fallback));
const like = (v: string) => `%${v.replace(/[\\%_]/g, c => "\\" + c)}%`;
const dollars = (row: Row) => ({ ...row, value: Number(row.value || 0) / 100 });
const STALL = "julianday('now')-julianday(COALESCE(NULLIF(d.stage_entered_at,''),d.updated_at,d.created_at))";
const stallDays = async (db: D1Database) => Number((await db.prepare("SELECT stagnation_days AS d FROM operation_settings WHERE id=1").first<{ d: number }>())?.d || 14);
const DEAL_COLUMNS = "d.id,d.name,d.company,d.company_id AS companyId,d.contact_id AS contactId,d.stage,d.stage_key AS stageKey,d.pipeline_key AS pipelineKey,d.status,d.owner,d.value,d.probability,d.next_step AS nextStep,d.close_date AS closeDate,d.forecast_category AS forecastCategory,d.lead_source AS leadSource,d.closed_reason AS closedReason,d.stage_entered_at AS stageEnteredAt,d.updated_at AS updatedAt";

export async function dealDetail(db: D1Database, id: number) {
  const deal = await db.prepare(`SELECT ${DEAL_COLUMNS} FROM deals d WHERE d.id=?`).bind(id).first<Row>(); if (!deal) return null;
  const [notes, activities, tasks, stakeholders, stageHistory] = await db.batch([
    db.prepare("SELECT id,kind,body,owner,pinned,created_at AS createdAt FROM deal_notes WHERE deal_id=? ORDER BY pinned DESC,created_at DESC LIMIT 20").bind(id),
    db.prepare("SELECT id,type,subject,body,outcome,owner,happened_at AS happenedAt FROM deal_activities WHERE deal_id=? ORDER BY happened_at DESC LIMIT 20").bind(id),
    db.prepare("SELECT id,title,owner,due_date AS dueDate,completed FROM deal_tasks WHERE deal_id=? AND completed=0 ORDER BY due_date LIMIT 20").bind(id),
    db.prepare("SELECT s.role,s.notes,s.contact_id AS contactId,c.first_name||' '||c.last_name AS name,c.email,c.title FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? AND s.active=1 ORDER BY s.is_primary DESC,s.id LIMIT 50").bind(id),
    db.prepare("SELECT from_stage AS fromStage,to_stage AS toStage,actor,happened_at AS happenedAt FROM deal_stage_history WHERE deal_id=? ORDER BY happened_at DESC LIMIT 10").bind(id),
  ]);
  return { deal: dollars(deal), notes: notes.results as Row[], activities: activities.results as Row[], tasks: tasks.results as Row[], stakeholders: stakeholders.results as Row[], stageHistory: stageHistory.results as Row[] };
}

export async function listDeals(db: D1Database, filter: { q?: string; stage?: string; owner?: string; status?: "Open" | "Won" | "Lost" | "All"; closingWithinDays?: number; stalledOnly?: boolean; offset?: number; limit?: number }) {
  const where: string[] = [], binds: (string | number)[] = [], status = filter.status || "Open", limit = cap(filter.limit), offset = Math.max(0, Number(filter.offset) || 0);
  if (status !== "All") { where.push("d.status=?"); binds.push(status); }
  if (filter.q?.trim()) { where.push("(d.name LIKE ? ESCAPE '\\' OR d.company LIKE ? ESCAPE '\\')"); binds.push(like(filter.q.trim()), like(filter.q.trim())); }
  if (filter.stage?.trim()) { where.push("lower(d.stage)=lower(?)"); binds.push(filter.stage.trim()); }
  if (filter.owner?.trim()) { where.push("lower(d.owner)=lower(?)"); binds.push(filter.owner.trim()); }
  if (filter.closingWithinDays) { where.push("d.close_date IS NOT NULL AND date(d.close_date)<=date('now',?)"); binds.push(`+${Math.max(0, Math.min(365, Number(filter.closingWithinDays)))} days`); }
  if (filter.stalledOnly) { where.push(`d.status='Open' AND ${STALL}>=?`); binds.push(await stallDays(db)); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [page, count] = await db.batch([db.prepare(`SELECT ${DEAL_COLUMNS} FROM deals d ${clause} ORDER BY d.updated_at DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset), db.prepare(`SELECT count(*) AS n FROM deals d ${clause}`).bind(...binds)]);
  return { rows: (page.results as Row[]).map(dollars), total: Number((count.results[0] as Row)?.n || 0), offset, limit };
}

export async function listTasks(db: D1Database, filter: { scope: "mine" | "overdue" | "due_soon" | "all"; owners?: string[]; contactId?: number; dealId?: number; limit?: number; today?: string }) {
  const today = filter.today || new Date().toISOString().slice(0, 10), limit = cap(filter.limit), owners = (filter.owners || []).map(o => o.toLowerCase());
  if (filter.scope !== "all" && !owners.length) return { rows: [] };
  const conditions = (alias: string, dueCol: string, doneCol: string) => {
    const parts = [`${alias}.${doneCol}=0`], binds: (string | number)[] = [];
    if (filter.scope !== "all") { parts.push(`lower(${alias}.owner) IN (${owners.map(() => "?").join(",")})`); binds.push(...owners); }
    if (filter.scope === "overdue") { parts.push(`${alias}.${dueCol}<?`); binds.push(today); }
    if (filter.scope === "due_soon") { parts.push(`${alias}.${dueCol}>=? AND ${alias}.${dueCol}<=date(?, '+7 days')`); binds.push(today, today); }
    return { sql: parts.join(" AND "), binds };
  };
  const c = conditions("t", "due_date", "completed"), d = c;
  const contactPart = filter.dealId ? null : db.prepare(`SELECT 'contact' AS kind,t.id,t.title,t.owner,t.due_date AS dueDate,t.completed,t.contact_id AS contactId,NULL AS dealId,c.first_name||' '||c.last_name AS recordName FROM tasks t JOIN contacts c ON c.id=t.contact_id WHERE ${c.sql}${filter.contactId ? " AND t.contact_id=?" : ""} ORDER BY t.due_date LIMIT ?`).bind(...c.binds, ...(filter.contactId ? [filter.contactId] : []), limit);
  const dealPart = filter.contactId ? null : db.prepare(`SELECT 'deal' AS kind,t.id,t.title,t.owner,t.due_date AS dueDate,t.completed,NULL AS contactId,t.deal_id AS dealId,x.name AS recordName FROM deal_tasks t JOIN deals x ON x.id=t.deal_id WHERE ${d.sql}${filter.dealId ? " AND t.deal_id=?" : ""} ORDER BY t.due_date LIMIT ?`).bind(...d.binds, ...(filter.dealId ? [filter.dealId] : []), limit);
  const results = await db.batch([contactPart, dealPart].filter(Boolean) as D1PreparedStatement[]);
  const rows = results.flatMap(r => r.results as Row[]).map((r): Row => ({ ...r, completed: Boolean(r.completed) })).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, limit);
  return { rows };
}

export async function pipelineSummary(db: D1Database) {
  const days = await stallDays(db);
  const [byStage, forecast, stalled] = await db.batch([
    db.prepare("SELECT stage,count(*) AS count,COALESCE(sum(value),0) AS value FROM deals WHERE status='Open' GROUP BY stage ORDER BY stage"),
    db.prepare("SELECT COALESCE(sum(value*probability/100.0),0) AS weighted,COALESCE(sum(value),0) AS open FROM deals WHERE status='Open'"),
    db.prepare(`SELECT d.id,d.name,d.stage,CAST(${STALL} AS INTEGER) AS days FROM deals d WHERE d.status='Open' AND ${STALL}>=? ORDER BY days DESC LIMIT 20`).bind(days),
  ]);
  const f = forecast.results[0] as Row;
  return { byStage: (byStage.results as Row[]).map(r => ({ stage: String(r.stage), count: Number(r.count), value: Number(r.value) / 100 })), weightedForecast: Math.round(Number(f?.weighted || 0)) / 100, openValue: Number(f?.open || 0) / 100, stalled: (stalled.results as Row[]).map(r => ({ id: Number(r.id), name: String(r.name), stage: String(r.stage), days: Number(r.days) })), stallDays: days };
}
