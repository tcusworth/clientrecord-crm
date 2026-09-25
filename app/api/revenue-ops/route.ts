import { env } from "cloudflare:workers";
import { audit, can, canAdmin, crmUser } from "@/lib/crm-auth";
import { captureInboxMessage, captureLead } from "@/lib/revenue-ops";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const id=(value:unknown)=>{const n=Number(value);if(!Number.isInteger(n)||n<1)throw new Error("Choose a valid record.");return n};
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];

export async function GET(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!can(user,"records.view"))return Response.json({error:"View access is required."},{status:403});
 const [leads,messages,contacts,companies,deals,incomplete,duplicates,proposals,brand]=await Promise.all([
  rows("SELECT l.*,c.first_name||' '||c.last_name AS contact_name,co.name AS matched_company,t.title AS task_title FROM lead_intakes l LEFT JOIN contacts c ON c.id=l.contact_id LEFT JOIN companies co ON co.id=l.company_id LEFT JOIN tasks t ON t.id=l.task_id ORDER BY l.received_at DESC LIMIT 150"),
  rows("SELECT m.*,c.first_name||' '||c.last_name AS contact_name,co.name AS company_name,d.name AS deal_name FROM inbox_messages m LEFT JOIN contacts c ON c.id=m.contact_id LEFT JOIN companies co ON co.id=m.company_id LEFT JOIN deals d ON d.id=m.deal_id ORDER BY m.occurred_at DESC LIMIT 150"),
  rows("SELECT id,first_name||' '||last_name AS name,email,company,title FROM contacts ORDER BY first_name,last_name LIMIT 500"),
  rows("SELECT id,name,domain,website,owner,industry,territory FROM companies ORDER BY name LIMIT 500"),
  rows("SELECT id,name,company,company_id AS companyId,contact_id AS contactId,stage,owner FROM deals WHERE status='Open' ORDER BY updated_at DESC LIMIT 500"),
  rows("SELECT 'Company' AS kind,id,name,website,domain,owner,industry FROM companies WHERE trim(website)='' OR trim(domain)='' OR trim(owner)='' OR trim(industry)='' ORDER BY updated_at DESC LIMIT 120"),
  rows("SELECT a.id AS aId,a.name AS aName,a.domain AS domain,b.id AS bId,b.name AS bName FROM companies a JOIN companies b ON a.id<b.id AND ((a.domain<>'' AND lower(a.domain)=lower(b.domain)) OR lower(a.name)=lower(b.name)) ORDER BY a.name LIMIT 120"),
  rows("SELECT p.id,p.deal_id AS dealId,p.title,p.amount,p.status,p.valid_until AS validUntil,p.sent_at AS sentAt,p.opened_at AS openedAt,p.accepted_at AS acceptedAt,p.accepted_by AS acceptedBy,p.body_markdown AS bodyMarkdown,d.name AS dealName,d.company FROM deal_proposals p JOIN deals d ON d.id=p.deal_id ORDER BY p.updated_at DESC LIMIT 100"),
  rows("SELECT business_name AS businessName,logo_url AS logoUrl,physical_address AS physicalAddress FROM brand_settings WHERE id=1"),
 ]);
 return Response.json({account:{email:user.email,role:user.role},leads,messages,contacts,companies,deals,incomplete,duplicates,proposals,brand:brand[0]||{businessName:"ClientRecord",logoUrl:"",physicalAddress:""},endpoints:{leadCapture:`${new URL(request.url).origin}/api/lead-capture`,inboxCapture:`${new URL(request.url).origin}/api/inbox-capture`}});
}

export async function POST(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!can(user,"records.edit"))return Response.json({error:"Edit access is required."},{status:403});
 try{const body=await request.json() as Row,action=clean(body.action,80),now=new Date().toISOString();
  if(action==="captureLead")return Response.json(await captureLead(body,user),{status:201});
  if(action==="captureInbox")return Response.json(await captureInboxMessage(body,user),{status:201});
  if(action==="routeLead"){
    const leadId=clean(body.id,100),owner=clean(body.owner,200)||user.email,status=clean(body.status,60)||"Routed";await env.DB.prepare("UPDATE lead_intakes SET owner=?,status=?,routed_at=COALESCE(routed_at,?),resolved_at=CASE WHEN ? IN ('Resolved','Rejected') THEN ? ELSE resolved_at END WHERE id=?").bind(owner,status,now,status,now,leadId).run();await audit(user,"lead.route","lead_intake",leadId,"Updated lead routing",{owner,status});
  }else if(action==="assignInbox"){
    const messageId=clean(body.id,100),contactId=id(body.contactId),companyId=body.companyId? id(body.companyId):null,dealId=body.dealId?id(body.dealId):null,owner=clean(body.owner,200)||user.email,message=(await rows("SELECT * FROM inbox_messages WHERE id=?",messageId))[0];if(!message)throw new Error("Inbox message not found.");
    const taskTitle=clean(body.taskTitle,240),statements=[env.DB.prepare("UPDATE inbox_messages SET contact_id=?,company_id=?,deal_id=?,owner=?,status='Assigned',updated_at=? WHERE id=?").bind(contactId,companyId,dealId,owner,now,messageId),env.DB.prepare("INSERT INTO activities(contact_id,type,note,happened_at) VALUES (?,'Email received',?,?)").bind(contactId,String(message.subject||"Inbound email"),String(message.occurred_at))];
    if(dealId)statements.push(env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,source,external_id,pinned,created_at,updated_at) VALUES (?,?,?,'Email received',?,?,?,?,?,'CRM inbox',?,0,?,?)").bind(dealId,companyId,contactId,String(message.subject||"Inbound email"),String(message.body||""),owner,"Received",String(message.occurred_at),messageId,now,now));
    if(taskTitle)statements.push(env.DB.prepare("INSERT INTO tasks(contact_id,title,due_date,owner,status,completed) VALUES (?,?,date('now'),?,'Open',0)").bind(contactId,taskTitle,owner));
    await env.DB.batch(statements);await audit(user,"inbox.assign","inbox_message",messageId,"Associated inbox email with CRM records",{contactId,companyId,dealId,taskTitle});
  }else if(action==="updateProposalStatus"){
    const proposalId=id(body.id),status=clean(body.status,30);if(!["Draft","Sent","Opened","Accepted","Declined","Expired"].includes(status))throw new Error("Choose a valid proposal status.");const row=(await rows("SELECT * FROM deal_proposals WHERE id=?",proposalId))[0];if(!row)throw new Error("Proposal not found.");if(status==="Accepted"&&!canAdmin(user.role))return Response.json({error:"Only an owner or admin can manually mark a proposal accepted."},{status:403});const acceptedBy=clean(body.acceptedBy,200)||user.email;await env.DB.prepare("UPDATE deal_proposals SET status=?,sent_at=CASE WHEN ?='Sent' THEN COALESCE(sent_at,?) ELSE sent_at END,opened_at=CASE WHEN ?='Opened' THEN COALESCE(opened_at,?) ELSE opened_at END,accepted_at=CASE WHEN ?='Accepted' THEN COALESCE(accepted_at,?) ELSE accepted_at END,accepted_by=CASE WHEN ?='Accepted' THEN ? ELSE accepted_by END,updated_at=? WHERE id=?").bind(status,status,now,status,now,status,now,status,acceptedBy,now,proposalId).run();await audit(user,"proposal.status","deal_proposal",proposalId,`Marked proposal ${status.toLowerCase()}`,{status,actor:user.email,...(status==="Accepted"?{acceptedBy,manual:true}:{})});
  }else if(action==="mergeCompanies"){
    if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});const sourceId=id(body.sourceId),targetId=id(body.targetId);if(sourceId===targetId)throw new Error("Choose different companies.");const source=(await rows("SELECT * FROM companies WHERE id=?",sourceId))[0],target=(await rows("SELECT * FROM companies WHERE id=?",targetId))[0];if(!source||!target)throw new Error("Company not found.");await env.DB.batch([env.DB.prepare("UPDATE contacts SET company=?,updated_at=? WHERE lower(company)=lower(?)").bind(String(target.name),now,String(source.name)),env.DB.prepare("UPDATE deals SET company_id=?,company=?,updated_at=? WHERE company_id=?").bind(targetId,String(target.name),now,sourceId),env.DB.prepare("UPDATE client_documents SET company_id=?,updated_at=? WHERE company_id=?").bind(targetId,now,sourceId),env.DB.prepare("UPDATE inbox_messages SET company_id=?,updated_at=? WHERE company_id=?").bind(targetId,now,sourceId),env.DB.prepare("UPDATE lead_intakes SET company_id=? WHERE company_id=?").bind(targetId,sourceId),env.DB.prepare("DELETE FROM companies WHERE id=?").bind(sourceId)]);await audit(user,"company.merge","company",targetId,`Merged ${source.name} into ${target.name}`,{sourceId,targetId});
  }else if(action==="matchCompanyDomain"){
    const companyId=id(body.companyId),company=(await rows("SELECT * FROM companies WHERE id=?",companyId))[0];if(!company||!String(company.domain||""))throw new Error("The company needs a domain first.");const result=await env.DB.prepare("UPDATE contacts SET company=?,updated_at=? WHERE trim(company)='' AND lower(substr(email,instr(email,'@')+1))=lower(?)").bind(String(company.name),now,String(company.domain)).run();await audit(user,"company.domain_match","company",companyId,"Matched contacts by company domain",{domain:company.domain,updated:result.meta.changes});
  }else throw new Error("Unknown revenue operations action.");return Response.json({ok:true});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"The change could not be saved."},{status:400});}
}
