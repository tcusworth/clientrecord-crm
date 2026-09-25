import { env } from "cloudflare:workers";
import { audit, can, canAdmin, crmUser } from "@/lib/crm-auth";
import { runDueAutomations } from "@/lib/operations";

const clean = (value: unknown, fallback = "") => typeof value === "string" ? value.trim() : fallback;
const money = (value: unknown) => Math.max(0, Math.round(Number(value || 0) * 100));

async function readAll(user: NonNullable<Awaited<ReturnType<typeof crmUser>>>) {
  const [deals, sources, sequences, steps, enrollments, fields, values, members, logs, integration] = await Promise.all([
    env.DB.prepare("SELECT d.id,d.name,d.company,d.contact_id AS contactId,d.stage,d.owner,d.value,d.probability,d.next_step AS nextStep,d.close_date AS closeDate,d.lead_source AS leadSource,CASE WHEN d.stage_key IS NULL AND d.stage IN ('Won','Lost') THEN d.stage ELSE d.status END AS status,d.created_at AS createdAt,d.updated_at AS updatedAt,c.first_name||' '||c.last_name AS contactName FROM deals d LEFT JOIN contacts c ON c.id=d.contact_id ORDER BY d.updated_at DESC").all(),
    env.DB.prepare("SELECT id,name,spend,created_at AS createdAt,updated_at AS updatedAt FROM lead_sources ORDER BY name").all(),
    env.DB.prepare("SELECT id,name,trigger_type AS triggerType,trigger_value AS triggerValue,active,created_at AS createdAt,updated_at AS updatedAt FROM automation_sequences ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT id,sequence_id AS sequenceId,step_order AS stepOrder,delay_days AS delayDays,action_type AS actionType,subject,body,task_title AS taskTitle FROM automation_steps ORDER BY sequence_id,step_order").all(),
    env.DB.prepare("SELECT e.id,e.sequence_id AS sequenceId,e.contact_id AS contactId,e.current_step AS currentStep,e.status,e.next_run_at AS nextRunAt,e.enrolled_at AS enrolledAt,c.first_name||' '||c.last_name AS contactName,s.name AS sequenceName FROM automation_enrollments e JOIN contacts c ON c.id=e.contact_id JOIN automation_sequences s ON s.id=e.sequence_id ORDER BY e.enrolled_at DESC").all(),
    env.DB.prepare("SELECT id,entity_type AS entityType,name,field_key AS fieldKey,field_type AS fieldType,options,created_at AS createdAt FROM custom_field_definitions ORDER BY name").all(),
    env.DB.prepare("SELECT id,definition_id AS definitionId,entity_type AS entityType,entity_id AS entityId,value,updated_at AS updatedAt FROM custom_field_values").all(),
    env.DB.prepare("SELECT id,email,name,role,active,created_at AS createdAt,updated_at AS updatedAt FROM team_members ORDER BY role,email").all(),
    env.DB.prepare("SELECT id,actor_email AS actorEmail,action,entity_type AS entityType,entity_id AS entityId,summary,changes,created_at AS createdAt FROM audit_logs ORDER BY created_at DESC LIMIT 250").all(),
    env.DB.prepare("SELECT provider,account_email AS accountEmail,last_synced_at AS lastSyncedAt FROM integration_accounts WHERE provider='microsoft'").first<Record<string, unknown>>(),
  ]);
  const dealRows = deals.results as Array<Record<string, unknown>>;
  const won = dealRows.filter(d => d.status === "Won");
  const sourceNames = new Set<string>([...sources.results.map(s => String(s.name)), ...dealRows.map(d => String(d.leadSource || "Direct"))]);
  const sourceROI = Array.from(sourceNames).map(name => {
    const related = dealRows.filter(d => String(d.leadSource || "Direct") === name);
    const revenue = related.filter(d => d.status === "Won").reduce((sum, d) => sum + Number(d.value || 0), 0);
    const spend = Number(sources.results.find(s => s.name === name)?.spend || 0);
    return { name, leads: related.length, won: related.filter(d => d.status === "Won").length, revenue, spend, roi: spend ? ((revenue - spend) / spend) * 100 : null };
  });
  const pipeline = Array.from(new Set(dealRows.map(d=>String(d.stage)))).map(stage => ({ stage, count: dealRows.filter(d => d.stage === stage).length, value: dealRows.filter(d => d.stage === stage).reduce((sum, d) => sum + Number(d.value || 0), 0) }));
  return {
    account: user,
    deals: dealRows, sources: sources.results, sequences: sequences.results.map(s => ({ ...s, active: Boolean(s.active), steps: steps.results.filter(x => x.sequenceId === s.id) })),
    enrollments: enrollments.results, fields: fields.results.map(f => ({ ...f, options: JSON.parse(String(f.options || "[]")) })), values: values.results,
    members: members.results.map(m => ({ ...m, active: Boolean(m.active) })), logs: canAdmin(user.role) ? logs.results : [],
    integration: { provider: "Microsoft 365", configured: Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.CRM_TOKEN_ENCRYPTION_KEY), connected: Boolean(integration), accountEmail: integration?.accountEmail || "", lastSyncedAt: integration?.lastSyncedAt || null },
    reports: { openPipeline: dealRows.filter(d => d.status === "Open").reduce((sum, d) => sum + Number(d.value || 0), 0), weightedPipeline: dealRows.filter(d => d.status === "Open").reduce((sum, d) => sum + Number(d.value || 0) * Number(d.probability || 0) / 100, 0), wonRevenue: won.reduce((sum, d) => sum + Number(d.value || 0), 0), winRate: dealRows.length ? won.length / dealRows.length * 100 : 0, pipeline, sourceROI },
  };
}

export async function GET(request: Request) {
  const user = await crmUser(request); if (!user) return Response.json({ error: "Sign in is required." }, { status: 401 });
  try { return Response.json(await readAll(user)); } catch (error) { console.error(error); return Response.json({ error: "Sales workspace is temporarily unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const user = await crmUser(request); if (!user) return Response.json({ error: "Sign in is required." }, { status: 401 });
  const body = await request.json() as Record<string, unknown>, action = clean(body.action);
  if (!can(user,"records.edit")) return Response.json({ error: "Record-edit permission is required." }, { status: 403 });
  try {
    if (action === "createDeal" || action === "updateDeal") return Response.json({error:"Use the configurable pipeline workspace to create or update deals."},{status:409});
    if (action === "saveSource") {
      const name = clean(body.name); if (!name) return Response.json({ error: "Source name is required." }, { status: 400 });
      await env.DB.prepare("INSERT INTO lead_sources (name,spend,created_at,updated_at) VALUES (?,?,datetime('now'),datetime('now')) ON CONFLICT(name) DO UPDATE SET spend=excluded.spend,updated_at=datetime('now')").bind(name, money(body.spend)).run();
      await audit(user, action, "lead_source", name, `Updated ${name} acquisition spend`, body); return Response.json({ status: "saved" });
    }
    if (action === "createSequence") {
      const name = clean(body.name), rows = Array.isArray(body.steps) ? body.steps as Array<Record<string, unknown>> : []; if (!name || !rows.length) return Response.json({ error: "Sequence name and at least one step are required." }, { status: 400 });
      const result = await env.DB.prepare("INSERT INTO automation_sequences (name,trigger_type,trigger_value,active,created_at,updated_at) VALUES (?,?,?,1,datetime('now'),datetime('now'))").bind(name, clean(body.triggerType, "Manual"), clean(body.triggerValue)).run();
      const id = Number(result.meta.last_row_id); await env.DB.batch(rows.slice(0, 10).map((step, index) => env.DB.prepare("INSERT INTO automation_steps (sequence_id,step_order,delay_days,action_type,subject,body,task_title) VALUES (?,?,?,?,?,?,?)").bind(id, index, Math.max(0, Number(step.delayDays) || 0), clean(step.actionType, "task"), clean(step.subject), clean(step.body), clean(step.taskTitle))));
      await audit(user, action, "sequence", id, `Created sequence ${name}`, { name, stepCount: rows.length }); return Response.json({ id }, { status: 201 });
    }
    if (action === "enrollSequence") {
      const sequenceId = Number(body.sequenceId), contactId = Number(body.contactId); const first = await env.DB.prepare("SELECT delay_days AS delayDays FROM automation_steps WHERE sequence_id=? ORDER BY step_order LIMIT 1").bind(sequenceId).first<{ delayDays: number }>();
      if (!sequenceId || !contactId || !first) return Response.json({ error: "Choose a contact and sequence." }, { status: 400 });
      const result = await env.DB.prepare("INSERT INTO automation_enrollments (sequence_id,contact_id,current_step,status,next_run_at,enrolled_at) VALUES (?,?,0,'Active',datetime('now',?),datetime('now'))").bind(sequenceId, contactId, `+${Math.max(0, first.delayDays)} days`).run();
      await audit(user, action, "enrollment", result.meta.last_row_id, "Enrolled contact in follow-up sequence", body); return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (action === "runAutomations") return Response.json(await runDueAutomations(user.email));
    if (action === "createField") {
      if (!canAdmin(user.role)) return Response.json({ error: "Admin access is required." }, { status: 403 });
      const name = clean(body.name), key = (clean(body.fieldKey)||name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), entityType=clean(body.entityType,"contact"), fieldType=clean(body.fieldType,"text"), options=clean(body.options).split(",").map(v=>v.trim()).filter(Boolean); if (!name || !key) return Response.json({ error: "Field name is required." }, { status: 400 });
      if(!["contact","company","deal"].includes(entityType)||!["text","number","date","select","boolean"].includes(fieldType))return Response.json({error:"Choose a supported record and field type."},{status:400});
      if(fieldType==="select"&&!options.length)return Response.json({error:"Add at least one option for a select field."},{status:400});
      const result = await env.DB.prepare("INSERT INTO custom_field_definitions (entity_type,name,field_key,field_type,options,created_at) VALUES (?,?,?,?,?,datetime('now'))").bind(entityType, name, key, fieldType, JSON.stringify(fieldType==="select"?options:[])).run();
      await audit(user, action, "custom_field", result.meta.last_row_id, `Created custom field ${name}`, body); return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (action === "setFieldValue") {
      const definitionId = Number(body.definitionId), entityId = Number(body.entityId); if (!definitionId || !entityId) return Response.json({ error: "Field and record are required." }, { status: 400 });
      await env.DB.batch([env.DB.prepare("DELETE FROM custom_field_values WHERE definition_id=? AND entity_type=? AND entity_id=?").bind(definitionId, clean(body.entityType, "contact"), entityId), env.DB.prepare("INSERT INTO custom_field_values (definition_id,entity_type,entity_id,value,updated_at) VALUES (?,?,?,?,datetime('now'))").bind(definitionId, clean(body.entityType, "contact"), entityId, clean(body.value))]);
      await audit(user, action, "custom_field_value", entityId, "Updated custom field value", body); return Response.json({ status: "saved" });
    }
    if (action === "saveMember") {
      if (user.role !== "owner") return Response.json({ error: "Owner access is required." }, { status: 403 });
      const email = clean(body.email).toLowerCase(), role = ["admin", "editor", "viewer"].includes(clean(body.role)) ? clean(body.role) : "viewer"; if (!email) return Response.json({ error: "Email is required." }, { status: 400 });
      await env.DB.prepare("INSERT INTO team_members (email,name,role,active,created_at,updated_at) VALUES (?,?,?,1,datetime('now'),datetime('now')) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,active=1,updated_at=datetime('now')").bind(email, clean(body.name), role).run();
      await audit(user, action, "team_member", email, `Granted ${role} access to ${email}`, { email, role }); return Response.json({ status: "saved" });
    }
    if (action === "disableMember") {
      if (user.role !== "owner") return Response.json({ error: "Owner access is required." }, { status: 403 });
      const id = Number(body.id); await env.DB.prepare("UPDATE team_members SET active=0,updated_at=datetime('now') WHERE id=?").bind(id).run(); await audit(user, action, "team_member", id, "Disabled team member"); return Response.json({ status: "disabled" });
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) { const message = error instanceof Error ? error.message : "The CRM could not save that change."; return Response.json({ error: message.includes("UNIQUE") ? "That record already exists." : message }, { status: 500 }); }
}
