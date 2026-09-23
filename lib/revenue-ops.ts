import { env } from "cloudflare:workers";
import { audit, type CRMUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const email=(value:unknown)=>clean(value,320).toLowerCase();
const domain=(value:unknown)=>{const valueText=clean(value,320).toLowerCase();const at=valueText.lastIndexOf("@");return at>0?valueText.slice(at+1):""};
const parts=(value:unknown)=>{const values=clean(value,240).split(/\s+/).filter(Boolean);return {firstName:values[0]||"",lastName:values.slice(1).join(" ")};};

export type LeadInput={source?:unknown;formName?:unknown;firstName?:unknown;lastName?:unknown;name?:unknown;email?:unknown;company?:unknown;website?:unknown;message?:unknown;attribution?:unknown;payload?:unknown};

export async function captureLead(input:LeadInput,user:CRMUser){
  const address=email(input.email);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))throw new Error("A valid email address is required.");
  const name=parts(input.name),firstName=clean(input.firstName||name.firstName,120),lastName=clean(input.lastName||name.lastName,120),companyName=clean(input.company,240),website=clean(input.website,500),source=clean(input.source||"Website",120)||"Website",now=new Date().toISOString();
  const existing=await env.DB.prepare("SELECT * FROM contacts WHERE lower(email)=lower(?)").bind(address).first<Row>();
  let companyId:number|null=null,owner=user.email;
  if(companyName){const company=await env.DB.prepare("SELECT * FROM companies WHERE lower(name)=lower(?) OR (domain<>'' AND lower(domain)=lower(?)) LIMIT 1").bind(companyName,domain(address)).first<Row>();if(company){companyId=Number(company.id);owner=clean(company.owner,200)||owner}else{const result=await env.DB.prepare("INSERT INTO companies(name,website,domain,stage,owner,updated_at) VALUES (?,?,?,'Prospect',?,?)").bind(companyName,website,domain(address),owner,now).run();companyId=Number(result.meta.last_row_id)}}
  let contactId:number|null=existing?Number(existing.id):null,duplicateContactId:number|null=existing?Number(existing.id):null,status=existing?"Duplicate":"New";
  if(!existing){const created=await env.DB.prepare("INSERT INTO contacts(first_name,last_name,email,company,title,phone,location,notes,lead_source,stage,tags,subscribed,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Lead','[]',1,?,?)").bind(firstName,lastName,address,companyName,"","","",clean(input.message,4000),source,now,now).run();contactId=Number(created.meta.last_row_id);duplicateContactId=null;}
  const task=await env.DB.prepare("INSERT INTO tasks(contact_id,title,due_date,owner,status,completed) VALUES (?,? ,date('now'),?,'Open',0)").bind(contactId,`Respond to ${firstName||address} · ${source}`,owner).run();
  const intakeId=crypto.randomUUID(),attribution=typeof input.attribution==="object"&&input.attribution?input.attribution:{},payload=typeof input.payload==="object"&&input.payload?input.payload:{};
  await env.DB.prepare("INSERT INTO lead_intakes(id,source,form_name,first_name,last_name,email,company_name,website,message,attribution_json,payload_json,status,owner,contact_id,company_id,duplicate_contact_id,task_id,received_at,routed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(intakeId,source,clean(input.formName,120),firstName,lastName,address,companyName,website,clean(input.message,8000),JSON.stringify(attribution),JSON.stringify(payload),status,owner,contactId,companyId,duplicateContactId,Number(task.meta.last_row_id),now,now).run();
  await audit(user,"lead.capture","lead_intake",intakeId,existing?"Captured a duplicate lead for review":"Captured and routed a lead",{source,email:address,contactId,companyId,duplicateContactId,owner});
  return {id:intakeId,status,contactId,companyId,owner,duplicate:Boolean(existing)};
}

export type InboxInput={provider?:unknown;externalId?:unknown;fromEmail?:unknown;fromName?:unknown;toEmails?:unknown;subject?:unknown;body?:unknown;attachmentNames?:unknown;occurredAt?:unknown};
export async function captureInboxMessage(input:InboxInput,user:CRMUser){
  const fromEmail=email(input.fromEmail);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail))throw new Error("A valid sender email is required.");
  const now=new Date().toISOString(),provider=clean(input.provider||"Manual",80)||"Manual",externalId=clean(input.externalId,240)||null,existing=externalId?await env.DB.prepare("SELECT id FROM inbox_messages WHERE provider=? AND external_id=?").bind(provider,externalId).first<Row>():null;if(existing)return {id:String(existing.id),duplicate:true};
  const contact=await env.DB.prepare("SELECT c.*,co.id AS company_id,co.owner AS company_owner FROM contacts c LEFT JOIN companies co ON lower(co.name)=lower(c.company) WHERE lower(c.email)=lower(?)").bind(fromEmail).first<Row>(),companyId=contact?.company_id?Number(contact.company_id):null,owner=clean(contact?.company_owner,200)||user.email;
  const id=crypto.randomUUID(),toEmails=Array.isArray(input.toEmails)?input.toEmails.map(value=>email(value)).filter(Boolean):clean(input.toEmails,1000).split(/[;,]/).map(email).filter(Boolean),attachments=Array.isArray(input.attachmentNames)?input.attachmentNames.map(value=>clean(value,240)).filter(Boolean):[];
  await env.DB.prepare("INSERT INTO inbox_messages(id,provider,external_id,direction,from_email,from_name,to_emails,subject,body,attachments_json,status,owner,contact_id,company_id,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,provider,externalId,"Inbound",fromEmail,clean(input.fromName,240),JSON.stringify(toEmails),clean(input.subject,500),clean(input.body,24000),JSON.stringify(attachments),contact?"Matched":"Unassigned",owner,contact?Number(contact.id):null,companyId,clean(input.occurredAt,60)||now,now,now).run();
  await audit(user,"inbox.capture","inbox_message",id,"Captured inbound email",{provider,fromEmail,matchedContactId:contact?.id||null,attachments:attachments.length});return {id,duplicate:false,matched:Boolean(contact)};
}
