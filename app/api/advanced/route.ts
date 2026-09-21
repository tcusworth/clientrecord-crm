import { env } from "cloudflare:workers";
import { audit, canAdmin, canEdit, crmUser } from "@/lib/crm-auth";
import { fromEmail, resend, resendConfigured } from "@/lib/resend";

const clean = (value: unknown, fallback = "") => typeof value === "string" ? value.trim() : fallback;
const money = (value: unknown) => Math.max(0, Math.round(Number(value || 0) * 100));
const stages = ["Qualified", "Discovery", "Proposal", "Negotiation", "Won", "Lost"];

async function readAll(user: NonNullable<Awaited<ReturnType<typeof crmUser>>>) {
  const [deals, sources, sequences, steps, enrollments, fields, values, members, logs, integration] = await Promise.all([
    env.DB.prepare("SELECT d.id,d.name,d.company,d.contact_id AS contactId,d.stage,d.owner,d.value,d.probability,d.next_step AS nextStep,d.close_date AS closeDate,d.lead_source AS leadSource,d.status,d.created_at AS createdAt,d.updated_at AS updatedAt,c.first_name||' '||c.last_name AS contactName FROM deals d LEFT JOIN contacts c ON c.id=d.contact_id ORDER BY d.updated_at DESC").all(),
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
  const won = dealRows.filter(d => d.stage === "Won");
  const sourceNames = new Set<string>([...sources.results.map(s => String(s.name)), ...dealRows.map(d => String(d.leadSource || "Direct"))]);
  const sourceROI = Array.from(sourceNames).map(name => {
    const related = dealRows.filter(d => String(d.leadSource || "Direct") === name);
    const revenue = related.filter(d => d.stage === "Won").reduce((sum, d) => sum + Number(d.value || 0), 0);
    const spend = Number(sources.results.find(s => s.name === name)?.spend || 0);
    return { name, leads: related.length, won: related.filter(d => d.stage === "Won").length, revenue, spend, roi: spend ? ((revenue - spend) / spend) * 100 : null };
  });
  const pipeline = stages.map(stage => ({ stage, count: dealRows.filter(d => d.stage === stage).length, value: dealRows.filter(d => d.stage === stage).reduce((sum, d) => sum + Number(d.value || 0), 0) }));
  return {
    account: user,
    deals: dealRows, sources: sources.results, sequences: sequences.results.map(s => ({ ...s, active: Boolean(s.active), steps: steps.results.filter(x => x.sequenceId === s.id) })),
    enrollments: enrollments.results, fields: fields.results.map(f => ({ ...f, options: JSON.parse(String(f.options || "[]")) })), values: values.results,
    members: members.results.map(m => ({ ...m, active: Boolean(m.active) })), logs: canAdmin(user.role) ? logs.results : [],
    integration: { provider: "Microsoft 365", configured: Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.CRM_TOKEN_ENCRYPTION_KEY), connected: Boolean(integration), accountEmail: integration?.accountEmail || "", lastSyncedAt: integration?.lastSyncedAt || null },
    reports: { openPipeline: dealRows.filter(d => !["Won", "Lost"].includes(String(d.stage))).reduce((sum, d) => sum + Number(d.value || 0), 0), weightedPipeline: dealRows.filter(d => !["Won", "Lost"].includes(String(d.stage))).reduce((sum, d) => sum + Number(d.value || 0) * Number(d.probability || 0) / 100, 0), wonRevenue: won.reduce((sum, d) => sum + Number(d.value || 0), 0), winRate: dealRows.length ? won.length / dealRows.length * 100 : 0, pipeline, sourceROI },
  };
}

async function runDue(user: NonNullable<Awaited<ReturnType<typeof crmUser>>>) {
  const due = await env.DB.prepare("SELECT e.id,e.sequence_id AS sequenceId,e.contact_id AS contactId,e.current_step AS currentStep,c.first_name AS firstName,c.last_name AS lastName,c.email FROM automation_enrollments e JOIN contacts c ON c.id=e.contact_id WHERE e.status='Active' AND e.next_run_at<=datetime('now') ORDER BY e.next_run_at LIMIT 100").all();
  let processed = 0;
  for (const row of due.results as Array<Record<string, unknown>>) {
    const step = await env.DB.prepare("SELECT * FROM automation_steps WHERE sequence_id=? AND step_order=?").bind(row.sequenceId, row.currentStep).first<Record<string, unknown>>();
    if (!step) { await env.DB.prepare("UPDATE automation_enrollments SET status='Completed',completed_at=datetime('now') WHERE id=?").bind(row.id).run(); continue; }
    if (step.action_type === "email") {
      if (!resendConfigured()) continue;
      const body = String(step.body || "").replaceAll("{{first_name}}", String(row.firstName));
      await resend("/emails", { method: "POST", body: JSON.stringify({ from: fromEmail(), to: [row.email], subject: step.subject, html: `<div style=\"font:16px Arial;line-height:1.6\">${body.replaceAll("\n", "<br>")}</div>` }) });
      await env.DB.prepare("INSERT INTO activities (contact_id,type,note,happened_at) VALUES (?,'Automated email',?,datetime('now'))").bind(row.contactId, `Sequence email: ${step.subject}`).run();
    } else {
      await env.DB.prepare("INSERT INTO tasks (contact_id,title,due_date,owner,status,completed) VALUES (?,?,date('now'),?,'Open',0)").bind(row.contactId, step.task_title || "Sequence follow-up", user.email).run();
    }
    const nextOrder = Number(row.currentStep) + 1;
    const next = await env.DB.prepare("SELECT delay_days AS delayDays FROM automation_steps WHERE sequence_id=? AND step_order=?").bind(row.sequenceId, nextOrder).first<{ delayDays: number }>();
    if (next) await env.DB.prepare("UPDATE automation_enrollments SET current_step=?,next_run_at=datetime('now',?) WHERE id=?").bind(nextOrder, `+${Math.max(0, next.delayDays)} days`, row.id).run();
    else await env.DB.prepare("UPDATE automation_enrollments SET status='Completed',completed_at=datetime('now') WHERE id=?").bind(row.id).run();
    processed++;
  }
  await audit(user, "automation.run", "sequence", null, `Processed ${processed} due automation steps`);
  return processed;
}

export async function GET(request: Request) {
  const user = await crmUser(request); if (!user) return Response.json({ error: "Sign in is required." }, { status: 401 });
  try { return Response.json(await readAll(user)); } catch (error) { console.error(error); return Response.json({ error: "Sales workspace is temporarily unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const user = await crmUser(request); if (!user) return Response.json({ error: "Sign in is required." }, { status: 401 });
  const body = await request.json() as Record<string, unknown>, action = clean(body.action);
  if (!canEdit(user.role)) return Response.json({ error: "Your viewer role is read-only." }, { status: 403 });
  try {
    if (action === "createDeal") {
      const name = clean(body.name); if (!name) return Response.json({ error: "Deal name is required." }, { status: 400 });
      const result = await env.DB.prepare("INSERT INTO deals (name,company,contact_id,stage,owner,value,probability,next_step,close_date,lead_source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))").bind(name, clean(body.company), Number(body.contactId) || null, clean(body.stage, "Qualified"), clean(body.owner, user.email), money(body.value), Math.min(100, Math.max(0, Number(body.probability) || 25)), clean(body.nextStep), clean(body.closeDate) || null, clean(body.leadSource, "Direct"), "Open").run();
      await audit(user, action, "deal", result.meta.last_row_id, `Created deal ${name}`, body); return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    }
    if (action === "updateDeal") {
      const id = Number(body.id), stage = stages.includes(clean(body.stage)) ? clean(body.stage) : "Qualified";
      await env.DB.prepare("UPDATE deals SET stage=?,owner=?,value=?,probability=?,next_step=?,close_date=?,lead_source=?,status=?,updated_at=datetime('now') WHERE id=?").bind(stage, clean(body.owner, user.email), money(body.value), Math.min(100, Math.max(0, Number(body.probability) || 0)), clean(body.nextStep), clean(body.closeDate) || null, clean(body.leadSource, "Direct"), stage === "Won" ? "Won" : stage === "Lost" ? "Lost" : "Open", id).run();
      const deal = await env.DB.prepare("SELECT contact_id AS contactId FROM deals WHERE id=?").bind(id).first<{contactId:number|null}>();
      if(deal?.contactId){const matched=await env.DB.prepare("SELECT s.id,(SELECT delay_days FROM automation_steps WHERE sequence_id=s.id ORDER BY step_order LIMIT 1) AS delayDays FROM automation_sequences s WHERE s.active=1 AND s.trigger_type='Deal stage' AND lower(s.trigger_value)=lower(?)").bind(stage).all();for(const sequence of matched.results){const exists=await env.DB.prepare("SELECT id FROM automation_enrollments WHERE sequence_id=? AND contact_id=? AND status='Active'").bind(sequence.id,deal.contactId).first();if(!exists)await env.DB.prepare("INSERT INTO automation_enrollments (sequence_id,contact_id,current_step,status,next_run_at,enrolled_at) VALUES (?,?,0,'Active',datetime('now',?),datetime('now'))").bind(sequence.id,deal.contactId,`+${Math.max(0,Number(sequence.delayDays)||0)} days`).run();}}
      await audit(user, action, "deal", id, `Updated deal stage to ${stage}`, body); return Response.json({ status: "updated" });
    }
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
    if (action === "runAutomations") return Response.json({ processed: await runDue(user) });
    if (action === "createField") {
      if (!canAdmin(user.role)) return Response.json({ error: "Admin access is required." }, { status: 403 });
      const name = clean(body.name), key = clean(body.fieldKey).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); if (!name || !key) return Response.json({ error: "Field name is required." }, { status: 400 });
      const result = await env.DB.prepare("INSERT INTO custom_field_definitions (entity_type,name,field_key,field_type,options,created_at) VALUES (?,?,?,?,?,datetime('now'))").bind(clean(body.entityType, "contact"), name, key, clean(body.fieldType, "text"), JSON.stringify(clean(body.options).split(",").map(v => v.trim()).filter(Boolean))).run();
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
