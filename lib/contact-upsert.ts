import { env } from "cloudflare:workers";
import { audit, type CRMUser } from "@/lib/crm-auth";
import { SOURCE_LABELS, type UpsertInput } from "@/lib/contact-upsert-input";

export type UpsertResult={contactId:number;action:"created"|"updated"|"duplicate";submissionId:string;lists:{id:number;name:string}[]};
const TASK_SOURCES=new Set(["contact_form","epc_inquiry"]);
async function readLists(names:string[]){
  if(!names.length)return [];
  const rows=(await env.DB.prepare(`SELECT id,name FROM contact_lists WHERE lower(name) IN (${names.map(()=>"lower(?)").join(",")})`).bind(...names).all<{id:number;name:string}>()).results||[];
  return names.map(n=>rows.find(r=>r.name.toLowerCase()===n.toLowerCase())).filter((r):r is {id:number;name:string}=>!!r).map(r=>({id:r.id,name:r.name}));
}

export async function upsertContact(input:UpsertInput,user:CRMUser):Promise<UpsertResult>{
  const db=env.DB,email=input.email,subscribe=input.consent===true?1:0;
  if(input.submissionId){
    const dup=await db.prepare("SELECT contact_id,action,lists_json FROM form_submissions WHERE submission_id=?").bind(input.submissionId).first<{contact_id:number;action:string;lists_json:string}>();
    if(dup){let names:string[]=[];try{const parsed=JSON.parse(dup.lists_json);if(Array.isArray(parsed))names=parsed.filter((n):n is string=>typeof n==="string")}catch{}return {contactId:dup.contact_id,action:"duplicate",submissionId:input.submissionId,lists:await readLists(names)}}
  }
  const existing=await db.prepare("SELECT id,first_name,last_name,title,company,subscribed,suppression_reason,first_source FROM contacts WHERE lower(email)=?").bind(email).first<{id:number;first_name:string;last_name:string;title:string;company:string;subscribed:number;suppression_reason:string|null;first_source:string}>();
  const suppressed=(await db.prepare("SELECT 1 AS x FROM suppressions WHERE lower(email)=? AND removed_at IS NULL").bind(email).first())?1:0;
  const where=existing?"id=?":"lower(email)=?",who=existing?existing.id:email,cid=`(SELECT id FROM contacts WHERE ${where})`;
  const s:D1PreparedStatement[]=[];
  if(existing)s.push(db.prepare("UPDATE contacts SET first_name=CASE WHEN ?<>'' THEN ? ELSE first_name END,last_name=CASE WHEN ?<>'' THEN ? ELSE last_name END,title=CASE WHEN ?<>'' THEN ? ELSE title END,company=CASE WHEN ?<>'' THEN ? ELSE company END,latest_source=?,first_source=CASE WHEN first_source='' THEN ? ELSE first_source END,subscribed=CASE WHEN ?=1 AND subscribed=0 AND coalesce(suppression_reason,'')='' AND ?=0 THEN 1 ELSE subscribed END,updated_at=datetime('now') WHERE id=?").bind(input.firstName,input.firstName,input.lastName,input.lastName,input.jobTitle,input.jobTitle,input.company,input.company,input.source,input.source,subscribe,suppressed,existing.id));
  else s.push(db.prepare("INSERT INTO contacts(first_name,last_name,email,company,title,stage,tags,subscribed,lead_source,first_source,latest_source,created_at,updated_at) VALUES (?,?,?,?,?,'Lead','[]',?,?,?,?,datetime('now'),datetime('now'))").bind(input.firstName,input.lastName,email,input.company,input.jobTitle,subscribe,input.source,input.source,input.source));
  if(input.note){
    const text=[input.note.title,input.note.body].filter(Boolean).join("\n\n").trim();
    s.push(db.prepare(`INSERT INTO activities(contact_id,type,note,happened_at) SELECT id,'Note',?,datetime('now') FROM contacts WHERE ${where}`).bind(text,who));
    s.push(db.prepare(`UPDATE contacts SET last_contact=date('now') WHERE ${where}`).bind(who));
  }
  for(const name of input.lists){
    s.push(db.prepare("INSERT OR IGNORE INTO contact_lists(name,created_at) VALUES (?,datetime('now'))").bind(name));
    s.push(db.prepare(`INSERT OR IGNORE INTO contact_list_members(list_id,contact_id,added_at,source) SELECT l.id,${cid},datetime('now'),? FROM contact_lists l WHERE lower(l.name)=lower(?)`).bind(who,input.source,name));
  }
  const first=input.firstName||existing?.first_name||email;
  const taskTitle=TASK_SOURCES.has(input.source)?`Respond to ${first} · ${SOURCE_LABELS[input.source]}`:"";
  if(taskTitle)s.push(db.prepare(`INSERT INTO tasks(contact_id,title,due_date,owner,status,completed) SELECT id,?,date('now'),?,'Open',0 FROM contacts WHERE ${where}`).bind(taskTitle,user.email,who));
  const names=input.lists;
  s.push(db.prepare(`INSERT INTO form_submissions(id,submission_id,contact_id,action,source,report_name,consent,consent_text,referrer,utm_source,utm_medium,utm_campaign,utm_term,utm_content,note_title,lists_json,task_id,api_key_id,created_at) SELECT ?,?,id,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT max(id) FROM tasks WHERE contact_id=contacts.id AND title=?),?,datetime('now') FROM contacts WHERE ${where}`).bind(crypto.randomUUID(),input.submissionId||null,existing?"updated":"created",input.source,input.reportName,input.consent===null?null:input.consent?1:0,input.consentText,input.referrer,input.utm.source,input.utm.medium,input.utm.campaign,input.utm.term,input.utm.content,input.note?.title||"",JSON.stringify(names),taskTitle,user.id.replace(/^api:/,""),who));
  await db.batch(s);
  const row=await db.prepare("SELECT id FROM contacts WHERE lower(email)=?").bind(email).first<{id:number}>();
  if(!row)throw new Error("Contact missing after upsert.");
  const action=existing?"updated":"created",lists=await readLists(names);
  try{await audit(user,"contact.upsert","contact",row.id,`${action} contact via website ${SOURCE_LABELS[input.source]}`,{source:input.source,action,submissionId:input.submissionId,lists:names})}catch(err){console.error("contact.upsert audit failed",err)}
  return {contactId:row.id,action,submissionId:input.submissionId,lists};
}
