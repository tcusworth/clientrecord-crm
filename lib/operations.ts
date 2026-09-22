import { env } from "cloudflare:workers";
import { fromEmail, resend, resendConfigured, sendingIdentity } from "@/lib/resend";

type Row = Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value, (key, item) => /token|secret/i.test(key) ? "[redacted]" : item).slice(0, 32000);
const ownerEmail = () => String(env.CRM_ALLOWED_EMAILS || "tcusworth@gmail.com").split(",")[0].trim().toLowerCase();

export async function systemEvent(severity: "info"|"warning"|"error", category: string, source: string, message: string, details: unknown = {}) {
  try { await env.DB.prepare("INSERT INTO system_events(severity,category,source,message,details,created_at) VALUES (?,?,?,?,?,datetime('now'))").bind(severity,category,source,message,json(details)).run(); }
  catch (error) { console.error("system event write failed", error); }
}

export async function notify(owner: string, kind: string, title: string, body: string, entityType?: string, entityId?: unknown, actionUrl?: string) {
  const recipient = owner.includes("@") ? owner.toLowerCase() : ownerEmail();
  await env.DB.prepare("INSERT INTO notifications(owner_email,kind,title,body,entity_type,entity_id,action_url,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
    .bind(recipient,kind,title,body,entityType||null,entityId==null?null:String(entityId),actionUrl||null).run();
}

export async function stopSequencesForReply(contactId: number, subject = "Reply received") {
  const result = await env.DB.prepare("UPDATE automation_enrollments SET status='Replied',stopped_reason=?,replied_at=datetime('now'),completed_at=datetime('now') WHERE contact_id=? AND status='Active'").bind(subject,contactId).run();
  return Number(result.meta.changes || 0);
}

async function recordDelivery(provider:string, kind:string, status:string, recipient:string, subject:string, externalId?:unknown, error?:unknown, context:unknown={}) {
  await env.DB.prepare("INSERT INTO delivery_logs(provider,kind,status,recipient,subject,external_id,error,context,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))")
    .bind(provider,kind,status,recipient,subject,externalId?String(externalId):null,error?String(error):"",json(context)).run();
}

export async function runDueAutomations(actor = "system") {
  const started = await env.DB.prepare("INSERT INTO job_runs(job_type,status,started_at) VALUES ('sequences','Running',datetime('now'))").run();
  const runId = Number(started.meta.last_row_id); let processed=0, failed=0;
  try {
    const due = await env.DB.prepare("SELECT e.id,e.sequence_id AS sequenceId,e.contact_id AS contactId,e.current_step AS currentStep,c.first_name AS firstName,c.last_name AS lastName,c.email,c.subscribed FROM automation_enrollments e JOIN contacts c ON c.id=e.contact_id WHERE e.status='Active' AND e.next_run_at<=datetime('now') ORDER BY e.next_run_at LIMIT 100").all<Row>();
    for (const row of due.results) {
      const step = await env.DB.prepare("SELECT * FROM automation_steps WHERE sequence_id=? AND step_order=?").bind(row.sequenceId,row.currentStep).first<Row>();
      if (!step) { await env.DB.prepare("UPDATE automation_enrollments SET status='Completed',completed_at=datetime('now') WHERE id=?").bind(row.id).run(); continue; }
      try {
        if (step.action_type === "email") {
          const blocked = !row.subscribed || await env.DB.prepare("SELECT id FROM suppressions WHERE lower(email)=lower(?) AND removed_at IS NULL").bind(row.email).first();
          if (blocked) { await env.DB.prepare("UPDATE automation_enrollments SET status='Suppressed',stopped_reason='Contact is unsubscribed or suppressed',completed_at=datetime('now') WHERE id=?").bind(row.id).run(); continue; }
          if (!resendConfigured()) throw new Error("Resend is not configured");
          const identity = await sendingIdentity();
          const body = String(step.body||"").replaceAll("{{first_name}}",String(row.firstName||"there"));
          const sent = await resend("/emails",{method:"POST",body:JSON.stringify({from:fromEmail(identity),to:[row.email],reply_to:identity.replyToEmail||undefined,subject:step.subject,html:`<div style=\"font:16px Arial;line-height:1.6\">${body.replaceAll("\n","<br>")}</div>`})}) as Row;
          await Promise.all([
            env.DB.prepare("INSERT INTO activities(contact_id,type,note,happened_at) VALUES (?,'Automated email',?,datetime('now'))").bind(row.contactId,`Sequence email: ${step.subject}`).run(),
            recordDelivery("resend","sequence","Sent",String(row.email),String(step.subject),sent.id,"",{enrollmentId:row.id,actor}),
          ]);
        } else {
          await env.DB.prepare("INSERT INTO tasks(contact_id,title,due_date,owner,status,completed) VALUES (?,?,date('now'),?,'Open',0)").bind(row.contactId,step.task_title||"Sequence follow-up",actor).run();
          await notify(actor,"task","Sequence task created",String(step.task_title||"Sequence follow-up"),"contact",row.contactId,"/?view=today");
        }
        const nextOrder=Number(row.currentStep)+1;
        const next=await env.DB.prepare("SELECT delay_days AS delayDays FROM automation_steps WHERE sequence_id=? AND step_order=?").bind(row.sequenceId,nextOrder).first<{delayDays:number}>();
        if(next) await env.DB.prepare("UPDATE automation_enrollments SET current_step=?,next_run_at=datetime('now',?) WHERE id=?").bind(nextOrder,`+${Math.max(0,next.delayDays)} days`,row.id).run();
        else await env.DB.prepare("UPDATE automation_enrollments SET status='Completed',completed_at=datetime('now') WHERE id=?").bind(row.id).run();
        processed++;
      } catch (error) {
        failed++; const message=error instanceof Error?error.message:String(error);
        await Promise.all([recordDelivery("resend",String(step.action_type||"automation"),"Failed",String(row.email||""),String(step.subject||step.task_title||""),undefined,message,{enrollmentId:row.id}),systemEvent("error","automation","sequence-runner",message,{enrollmentId:row.id})]);
      }
    }
    await env.DB.prepare("UPDATE job_runs SET status=?,processed=?,failed=?,message=?,completed_at=datetime('now') WHERE id=?").bind(failed?"Completed with errors":"Completed",processed,failed,`${processed} processed`,runId).run();
  } catch(error) {
    failed++; const message=error instanceof Error?error.message:String(error); await env.DB.prepare("UPDATE job_runs SET status='Failed',failed=?,message=?,completed_at=datetime('now') WHERE id=?").bind(failed,message,runId).run(); await systemEvent("error","automation","sequence-runner",message); throw error;
  }
  return {processed,failed};
}

export async function runStagnationAlerts() {
  const settings=await env.DB.prepare("SELECT stagnation_days AS days FROM operation_settings WHERE id=1").first<{days:number}>(); const days=Math.max(1,Number(settings?.days||14));
  const rows=(await env.DB.prepare("SELECT id,name,company,owner,stage,COALESCE(NULLIF(stage_entered_at,''),updated_at,created_at) AS enteredAt FROM deals WHERE status='Open' AND julianday('now')-julianday(COALESCE(NULLIF(stage_entered_at,''),updated_at,created_at))>=?").bind(days).all<Row>()).results;
  let created=0;
  for(const row of rows){ const exists=await env.DB.prepare("SELECT id FROM notifications WHERE kind='deal_stagnation' AND entity_id=? AND created_at>=datetime('now','-1 day')").bind(String(row.id)).first(); if(exists)continue; await notify(String(row.owner||ownerEmail()),"deal_stagnation",`${row.name} is stalled`,`${row.company||"Deal"} has been in ${row.stage} for at least ${days} days.`,"deal",row.id,"/?view=deals"); created++; }
  return created;
}

const exportTables=["contacts","companies","sales_pipelines","deals","account_stakeholders","account_signals","qualification_alerts","activities","tasks","deal_stage_history","deal_tasks","deal_activities","deal_notes","deal_stakeholders","deal_line_items","deal_insights","deal_reviews","client_documents","document_versions","deal_proposals","campaigns","campaign_events","segments","suppressions","consent_events","lead_sources","automation_sequences","automation_steps","automation_enrollments","custom_field_definitions","custom_field_values","team_members","audit_logs","sync_records","brand_settings","operation_settings"] as const;
const restoreInsertOrder=["contacts","companies","sales_pipelines","deals","account_stakeholders","account_signals","qualification_alerts","activities","tasks","deal_stage_history","deal_tasks","deal_activities","deal_notes","deal_stakeholders","deal_line_items","deal_insights","deal_reviews","client_documents","document_versions","deal_proposals","campaigns","campaign_events","segments","suppressions","consent_events","lead_sources","automation_sequences","automation_steps","automation_enrollments","custom_field_definitions","custom_field_values","team_members","audit_logs","sync_records","brand_settings","operation_settings"];
const restoreDeleteOrder=[...restoreInsertOrder].reverse();

async function checksum(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");}

export async function createBackup(createdBy:string, reason="scheduled") {
  if(!env.BUCKET) throw new Error("Backup object storage is not configured.");
  const id=crypto.randomUUID(), data:Record<string,unknown>={version:1,createdAt:new Date().toISOString(),reason,tables:{}}; let rowCount=0;
  for(const table of exportTables){const rows=(await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;(data.tables as Record<string,unknown>)[table]=rows;rowCount+=rows.length;}
  const payload=JSON.stringify(data), hash=await checksum(payload), objectKey=`crm-backups/${new Date().toISOString().slice(0,10)}/${id}.json`;
  await env.BUCKET.put(objectKey,payload,{httpMetadata:{contentType:"application/json"},customMetadata:{checksum:hash,rowCount:String(rowCount),reason}});
  await env.DB.prepare("INSERT INTO backup_snapshots(id,object_key,status,row_count,checksum,created_by,created_at) VALUES (?,?, 'Completed',?,?,?,datetime('now'))").bind(id,objectKey,rowCount,hash,createdBy).run();
  return {id,objectKey,rowCount,checksum:hash};
}

export async function restoreBackup(id:string, actor:string) {
  if(!env.BUCKET) throw new Error("Backup object storage is not configured.");
  const snapshot=await env.DB.prepare("SELECT object_key AS objectKey FROM backup_snapshots WHERE id=? AND status='Completed'").bind(id).first<{objectKey:string}>(); if(!snapshot)throw new Error("Backup snapshot was not found.");
  await createBackup(actor,"pre-restore"); const object=await env.BUCKET.get(snapshot.objectKey); if(!object)throw new Error("Backup object is unavailable.");
  const data=await object.json() as {tables:Record<string,Row[]>};
  for(const table of restoreDeleteOrder) await env.DB.prepare(`DELETE FROM ${table}`).run();
  for(const table of restoreInsertOrder){if(table==="audit_logs")await env.DB.prepare("DELETE FROM audit_logs").run();const rows=data.tables[table]||[];if(!rows.length)continue;const columns=Object.keys(rows[0]);for(let i=0;i<rows.length;i+=50){const statements=rows.slice(i,i+50).map(row=>env.DB.prepare(`INSERT INTO ${table} (${columns.map(c=>`\`${c}\``).join(",")}) VALUES (${columns.map(()=>"?").join(",")})`).bind(...columns.map(c=>row[c] as string|number|null)));await env.DB.batch(statements);}}
  await env.DB.prepare("UPDATE backup_snapshots SET restored_at=datetime('now') WHERE id=?").bind(id).run();
  return {restored:true};
}

export async function applyRetention() {
  const s=await env.DB.prepare("SELECT * FROM operation_settings WHERE id=1").first<Row>(); const days=(key:string,fallback:number)=>Math.max(1,Number(s?.[key]||fallback));
  const results=await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_logs WHERE created_at<datetime('now',?)").bind(`-${days("audit_retention_days",730)} days`),
    env.DB.prepare("DELETE FROM system_events WHERE created_at<datetime('now',?)").bind(`-${days("event_retention_days",90)} days`),
    env.DB.prepare("DELETE FROM delivery_logs WHERE created_at<datetime('now',?)").bind(`-${days("delivery_retention_days",180)} days`),
    env.DB.prepare("DELETE FROM sync_records WHERE created_at<datetime('now',?)").bind(`-${days("sync_retention_days",365)} days`),
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE created_at<datetime('now',?)").bind(`-${days("delivery_retention_days",180)} days`),
  ]); return results.reduce((sum,r)=>sum+Number(r.meta.changes||0),0);
}

export async function databaseHealth() {
  const started=Date.now(); const integrity=await env.DB.prepare("PRAGMA quick_check").first<Record<string,string>>(); const foreign=(await env.DB.prepare("PRAGMA foreign_key_check").all()).results; const tables=await env.DB.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").first<{count:number}>();
  return {status:Object.values(integrity||{}).includes("ok")&&!foreign.length?"Healthy":"Attention",integrity:Object.values(integrity||{})[0]||"unknown",foreignKeyIssues:foreign.length,tables:Number(tables?.count||0),latencyMs:Date.now()-started,checkedAt:new Date().toISOString()};
}

export async function runDailyMaintenance(actor="system") {
  const started=await env.DB.prepare("INSERT INTO job_runs(job_type,status,started_at) VALUES ('daily-maintenance','Running',datetime('now'))").run();const id=Number(started.meta.last_row_id);
  try { const sequences=await runDueAutomations(actor),alerts=await runStagnationAlerts(),purged=await applyRetention(),backup=await createBackup(actor,"daily"); const processed=sequences.processed+alerts+purged; await env.DB.prepare("UPDATE job_runs SET status='Completed',processed=?,failed=?,message=?,completed_at=datetime('now') WHERE id=?").bind(processed,sequences.failed,`Backup ${backup.id}; ${alerts} alerts; ${purged} records purged`,id).run(); return {sequences,alerts,purged,backup}; }
  catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.prepare("UPDATE job_runs SET status='Failed',failed=1,message=?,completed_at=datetime('now') WHERE id=?").bind(message,id).run();await systemEvent("error","job","daily-maintenance",message);throw error;}
}

export async function maybeRunDailyMaintenance(actor:string) {
  const running=await env.DB.prepare("SELECT id FROM job_runs WHERE job_type='daily-maintenance' AND status='Running' AND started_at>=datetime('now','-15 minutes') LIMIT 1").first();if(running)return false;
  const latest=await env.DB.prepare("SELECT completed_at AS completedAt FROM job_runs WHERE job_type='daily-maintenance' AND status='Completed' ORDER BY completed_at DESC LIMIT 1").first<{completedAt:string}>();
  if(latest?.completedAt && Date.now()-new Date(latest.completedAt).getTime()<20*3600000)return false;
  try { await runDailyMaintenance(actor); return true; }
  catch { return false; }
}
