import { env } from "cloudflare:workers";
import { audit, can, canAdmin, crmUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
const text=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const id=(value:unknown)=>{const n=Number(value);if(!Number.isInteger(n)||n<1)throw new Error("A valid record is required.");return n};
const money=(value:unknown)=>{const n=Number(value);if(!Number.isFinite(n)||n<0||n>1e10)throw new Error("Enter a valid amount.");return Math.round(n*100)};
const bool=(value:unknown)=>value===true||value===1||value==="1"||value==="true"||value==="on";
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();

async function dealRecord(dealId:number){
  const deal=await one("SELECT d.*,COALESCE(d.company_id,c.id) AS resolved_company_id FROM deals d LEFT JOIN companies c ON c.name=d.company WHERE d.id=?",dealId);
  if(!deal)throw new Error("Deal not found.");
  return deal;
}

function calculateHealth(deal:Row,tasks:Row[],activities:Row[],stakeholders:Row[],insights:Row[],reviews:Row[],lineItems:Row[]){
  let score=100;const reasons:string[]=[];const today=new Date().toISOString().slice(0,10);
  const subtract=(points:number,reason:string)=>{score-=points;reasons.push(reason)};
  if(String(deal.status)==="Open"&&!text(deal.next_step))subtract(20,"No next action");
  if(String(deal.status)==="Open"&&!deal.close_date)subtract(10,"No expected close date");
  if(tasks.some(task=>!task.completed&&String(task.due_date)<today))subtract(15,"Overdue deal task");
  const recent=activities.some(activity=>Date.parse(String(activity.happened_at))>=Date.now()-14*86400000);
  if(String(deal.status)==="Open"&&!recent)subtract(15,"No activity in 14 days");
  if(!stakeholders.length)subtract(10,"No deal stakeholders");
  if(insights.some(item=>item.kind==="Risk"&&item.status!=="Resolved"&&item.severity==="High"))subtract(15,"Unresolved high risk");
  if(["Proposal","Negotiation"].includes(String(deal.stage))&&!lineItems.length)subtract(10,"No products or line items");
  if(reviews.some(review=>review.status==="Rejected"))subtract(10,"Approval rejected");
  return {score:Math.max(0,score),status:score>=80?"Healthy":score>=55?"Watch":"At risk",reasons};
}

export async function GET(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  try{
    const url=new URL(request.url);
    if(url.searchParams.get("quality")==="1"){
      const [companyDuplicates,dealDuplicates,unmatchedDeals]=await Promise.all([
        rows(`SELECT a.id AS firstId,a.name AS firstName,b.id AS secondId,b.name AS secondName,
          CASE WHEN a.domain<>'' AND lower(a.domain)=lower(b.domain) THEN 'Matching domain' ELSE 'Similar company name' END AS reason
          FROM companies a JOIN companies b ON a.id<b.id AND ((a.domain<>'' AND lower(a.domain)=lower(b.domain)) OR lower(trim(a.name))=lower(trim(b.name))) ORDER BY a.name LIMIT 100`),
        rows(`SELECT a.id AS firstId,a.name AS firstName,b.id AS secondId,b.name AS secondName,'Matching open deal' AS reason
          FROM deals a JOIN deals b ON a.id<b.id AND lower(trim(a.name))=lower(trim(b.name)) AND COALESCE(a.company_id,0)=COALESCE(b.company_id,0) AND lower(a.company)=lower(b.company) AND a.status='Open' AND b.status='Open' LIMIT 100`),
        rows("SELECT id,name,company FROM deals WHERE company_id IS NULL AND company<>'' ORDER BY updated_at DESC LIMIT 100"),
      ]);
      return Response.json({companyDuplicates,dealDuplicates,unmatchedDeals});
    }
    const dealId=id(url.searchParams.get("dealId")),deal=await dealRecord(dealId);
    const [notes,activities,tasks,history,stakeholders,lineItems,insights,reviews,proposals,documents,unassigned]=await Promise.all([
      rows("SELECT * FROM deal_notes WHERE deal_id=? ORDER BY pinned DESC,created_at DESC",dealId),
      rows("SELECT a.*,c.first_name||' '||c.last_name AS contact_name FROM deal_activities a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.deal_id=? ORDER BY a.pinned DESC,a.happened_at DESC",dealId),
      rows("SELECT * FROM deal_tasks WHERE deal_id=? ORDER BY completed,due_date",dealId),
      rows("SELECT * FROM deal_stage_history WHERE deal_id=? ORDER BY happened_at DESC",dealId),
      rows("SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.email,c.title FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? ORDER BY s.is_primary DESC,c.first_name",dealId),
      rows("SELECT *,quantity*unit_price*(100-discount_percent)/100 AS total FROM deal_line_items WHERE deal_id=? ORDER BY id",dealId),
      rows("SELECT * FROM deal_insights WHERE deal_id=? ORDER BY CASE severity WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,created_at DESC",dealId),
      rows("SELECT * FROM deal_reviews WHERE deal_id=? ORDER BY requested_at DESC",dealId),
      rows("SELECT * FROM deal_proposals WHERE deal_id=? ORDER BY created_at DESC",dealId),
      rows(`SELECT d.*,v.filename,v.content_type,v.size,v.uploaded_at,v.uploaded_by
        FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version
        WHERE d.deal_id=? AND d.status='Active' AND (?=1 OR d.sensitive=0) ORDER BY d.updated_at DESC`,dealId,can(user,"documents.manage_sensitive")?1:0),
      deal.contact_id?rows(`SELECT a.id,a.type,a.note,a.happened_at,c.first_name||' '||c.last_name AS contact_name
        FROM activities a JOIN contacts c ON c.id=a.contact_id WHERE a.contact_id=? AND a.type IN ('Email','Email received','Email sent','Meeting','Calendar meeting','Call')
        AND NOT EXISTS(SELECT 1 FROM deal_activities da WHERE da.source='Contact activity' AND da.external_id=CAST(a.id AS TEXT)) ORDER BY a.happened_at DESC LIMIT 50`,Number(deal.contact_id)):Promise.resolve([]),
    ]);
    const health=calculateHealth(deal,tasks,activities,stakeholders,insights,reviews,lineItems);
    const timeline=[
      ...activities.map(item=>({id:`activity-${item.id}`,kind:"Activity",type:item.type,title:item.subject||item.type,detail:item.body,owner:item.owner,date:item.happened_at,pinned:Boolean(item.pinned)})),
      ...notes.map(item=>({id:`note-${item.id}`,kind:item.kind,title:item.kind,detail:item.body,owner:item.owner,date:item.created_at,pinned:Boolean(item.pinned)})),
      ...tasks.map(item=>({id:`task-${item.id}`,kind:"Task",title:item.title,detail:item.completed?"Completed":`Due ${item.due_date}`,owner:item.owner,date:item.created_at,pinned:false})),
      ...history.map(item=>({id:`stage-${item.id}`,kind:"Stage",title:`${item.from_stage} → ${item.to_stage}`,detail:item.reason,owner:item.actor,date:item.happened_at,pinned:false})),
      ...documents.map(item=>({id:`document-${item.id}`,kind:"Document",title:item.title,detail:`${item.category} · v${item.latest_version}`,owner:item.uploaded_by,date:item.uploaded_at,pinned:false})),
      ...reviews.map(item=>({id:`review-${item.id}`,kind:"Review",title:`${item.review_type}: ${item.status}`,detail:item.comments,owner:item.approver,date:item.decided_at||item.requested_at,pinned:false})),
    ].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||String(b.date).localeCompare(String(a.date)));
    return Response.json({deal,health,notes,activities,tasks,history,stakeholders,lineItems,insights,reviews,proposals,documents,unassigned,timeline,permissions:{edit:can(user,"records.edit"),delete:can(user,"records.delete"),upload:can(user,"documents.upload"),sensitive:can(user,"documents.manage_sensitive"),admin:canAdmin(user.role)}});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Deal workspace could not load."},{status:400})}
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  if(!can(user,"records.edit"))return Response.json({error:"Record-edit permission is required."},{status:403});
  try{
    const body=await request.json() as Row,action=text(body.action,80),now=new Date().toISOString(),dealId=body.dealId?id(body.dealId):0;
    if(dealId)await dealRecord(dealId);
    if(action==="saveNote"){
      const content=text(body.body);if(!content)throw new Error("Enter a note or comment.");
      const result=await env.DB.prepare("INSERT INTO deal_notes(deal_id,kind,body,owner,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(dealId,text(body.kind,30)||"Note",content,user.email,bool(body.pinned)?1:0,now,now).run();
      await audit(user,action,"deal_note",result.meta.last_row_id,"Added a deal note",{dealId,kind:body.kind,pinned:bool(body.pinned)});
    }else if(action==="toggleNotePin"){
      const noteId=id(body.id),before=await one("SELECT * FROM deal_notes WHERE id=? AND deal_id=?",noteId,dealId);if(!before)throw new Error("Note not found.");
      await env.DB.prepare("UPDATE deal_notes SET pinned=?,updated_at=? WHERE id=?").bind(bool(body.pinned)?1:0,now,noteId).run();await audit(user,action,"deal_note",noteId,"Changed pinned note status",{before,after:{pinned:bool(body.pinned)}});
    }else if(action==="saveActivity"){
      const type=text(body.type,50),content=text(body.body),happened=text(body.happenedAt,40)||now;if(!type||!content||!Number.isFinite(Date.parse(happened)))throw new Error("Activity type, details, and a valid date are required.");
      const deal=await dealRecord(dealId),contactId=body.contactId?id(body.contactId):deal.contact_id?Number(deal.contact_id):null,follow=text(body.followUpAt,20)||null;
      const result=await env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,follow_up_at,source,thread_key,external_id,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(dealId,deal.resolved_company_id?Number(deal.resolved_company_id):null,contactId,type,text(body.subject,240),content,text(body.owner,200)||user.email,text(body.outcome,1000),new Date(happened).toISOString(),follow,"Manual",text(body.threadKey,240)||null,null,bool(body.pinned)?1:0,now,now).run();
      if(follow)await env.DB.prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,created_at) VALUES (?,?,?,?,?)").bind(dealId,text(body.followUpTitle,240)||`Follow up: ${text(body.subject,180)||type}`,text(body.owner,200)||user.email,follow.slice(0,10),now).run();
      await audit(user,action,"deal_activity",result.meta.last_row_id,`Recorded ${type}`,{dealId,contactId,outcome:body.outcome,followUpAt:follow});
    }else if(action==="linkContactActivity"){
      const sourceId=id(body.activityId),source=await one("SELECT * FROM activities WHERE id=?",sourceId);if(!source)throw new Error("Activity not found.");const deal=await dealRecord(dealId);
      await env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,source,external_id,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Contact activity',?,0,?,?)").bind(dealId,deal.resolved_company_id?Number(deal.resolved_company_id):null,Number(source.contact_id),String(source.type),String(source.note).slice(0,240),String(source.note),user.email,"",String(source.happened_at),String(sourceId),now,now).run();
      await audit(user,action,"deal_activity",dealId,"Associated contact activity with deal",{sourceId});
    }else if(action==="saveStakeholder"){
      const contactId=id(body.contactId),role=text(body.role,80);if(!role)throw new Error("Choose a stakeholder role.");if(bool(body.isPrimary))await env.DB.prepare("UPDATE deal_stakeholders SET is_primary=0 WHERE deal_id=?").bind(dealId).run();
      await env.DB.prepare("INSERT INTO deal_stakeholders(deal_id,contact_id,role,notes,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(deal_id,contact_id) DO UPDATE SET role=excluded.role,notes=excluded.notes,is_primary=excluded.is_primary,updated_at=excluded.updated_at").bind(dealId,contactId,role,text(body.notes,2000),bool(body.isPrimary)?1:0,now,now).run();
      if(bool(body.isPrimary))await env.DB.prepare("UPDATE deals SET contact_id=?,updated_at=? WHERE id=?").bind(contactId,now,dealId).run();await audit(user,action,"deal_stakeholder",contactId,"Updated deal stakeholder",{dealId,role,isPrimary:bool(body.isPrimary)});
    }else if(action==="removeStakeholder"){
      const stakeholderId=id(body.id);if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});await env.DB.prepare("DELETE FROM deal_stakeholders WHERE id=? AND deal_id=?").bind(stakeholderId,dealId).run();await audit(user,action,"deal_stakeholder",stakeholderId,"Removed deal stakeholder",{dealId});
    }else if(action==="saveLineItem"){
      const result=await env.DB.prepare("INSERT INTO deal_line_items(deal_id,name,sku,quantity,unit_price,discount_percent,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(dealId,text(body.name,240)||"Line item",text(body.sku,120),Math.max(1,Math.round(Number(body.quantity)||1)),money(body.unitPrice),Math.min(100,Math.max(0,Math.round(Number(body.discountPercent)||0))),text(body.notes,1000),now,now).run();await audit(user,action,"deal_line_item",result.meta.last_row_id,"Added a deal line item",{dealId,name:body.name});
    }else if(action==="deleteLineItem"){
      if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});const lineId=id(body.id);await env.DB.prepare("DELETE FROM deal_line_items WHERE id=? AND deal_id=?").bind(lineId,dealId).run();await audit(user,action,"deal_line_item",lineId,"Deleted a deal line item",{dealId});
    }else if(action==="syncDealValue"){
      const total=await one("SELECT COALESCE(SUM(quantity*unit_price*(100-discount_percent)/100),0) AS total FROM deal_line_items WHERE deal_id=?",dealId);await env.DB.prepare("UPDATE deals SET value=?,updated_at=? WHERE id=?").bind(Number(total?.total||0),now,dealId).run();await audit(user,action,"deal",dealId,"Updated deal value from line items",{value:total?.total});
    }else if(action==="saveInsight"){
      const kind=text(body.kind,60);if(!["Competitor","Risk","Objection","Decision criterion"].includes(kind))throw new Error("Choose a valid insight type.");const result=await env.DB.prepare("INSERT INTO deal_insights(deal_id,kind,title,detail,severity,status,owner,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(dealId,kind,text(body.title,240)||kind,text(body.detail),text(body.severity,20)||"Medium",text(body.status,30)||"Open",text(body.owner,200)||user.email,now,now).run();await audit(user,action,"deal_insight",result.meta.last_row_id,`Added ${kind.toLowerCase()}`,{dealId,title:body.title});
    }else if(action==="resolveInsight"){
      const insightId=id(body.id);await env.DB.prepare("UPDATE deal_insights SET status=?,updated_at=? WHERE id=? AND deal_id=?").bind(text(body.status,30)||"Resolved",now,insightId,dealId).run();await audit(user,action,"deal_insight",insightId,"Updated deal insight status",{dealId,status:body.status});
    }else if(action==="requestReview"){
      const result=await env.DB.prepare("INSERT INTO deal_reviews(deal_id,review_type,status,approver,requested_by,comments,requested_at) VALUES (?,?,'Requested',?,?,?,?)").bind(dealId,text(body.reviewType,100)||"Deal review",text(body.approver,200)||user.email,user.email,text(body.comments,2000),now).run();await audit(user,action,"deal_review",result.meta.last_row_id,"Requested deal approval",{dealId,approver:body.approver});
    }else if(action==="decideReview"){
      const reviewId=id(body.id),status=text(body.status,20);if(!["Approved","Rejected"].includes(status))throw new Error("Choose approved or rejected.");await env.DB.prepare("UPDATE deal_reviews SET status=?,comments=?,decided_at=? WHERE id=? AND deal_id=?").bind(status,text(body.comments,2000),now,reviewId,dealId).run();await audit(user,action,"deal_review",reviewId,`${status} deal review`,{dealId,status});
    }else if(action==="saveProposal"){
      const result=await env.DB.prepare("INSERT INTO deal_proposals(deal_id,title,amount,status,valid_until,document_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(dealId,text(body.title,240)||"Proposal",money(body.amount),text(body.status,30)||"Draft",text(body.validUntil,20)||null,text(body.documentId,80)||null,user.email,now,now).run();await audit(user,action,"deal_proposal",result.meta.last_row_id,"Added quote or proposal",{dealId,title:body.title,amount:body.amount});
    }else if(action==="mergeCompany"){
      if(!canAdmin(user.role))return Response.json({error:"Admin access is required."},{status:403});const sourceId=id(body.sourceId),targetId=id(body.targetId);if(sourceId===targetId)throw new Error("Choose two different companies.");const source=await one("SELECT * FROM companies WHERE id=?",sourceId),target=await one("SELECT * FROM companies WHERE id=?",targetId);if(!source||!target)throw new Error("Company not found.");
      await env.DB.batch([
        env.DB.prepare("UPDATE contacts SET company=?,updated_at=? WHERE lower(company)=lower(?)").bind(String(target.name),now,String(source.name)),
        env.DB.prepare("UPDATE deals SET company_id=?,company=?,updated_at=? WHERE company_id=? OR lower(company)=lower(?)").bind(targetId,String(target.name),now,sourceId,String(source.name)),
        env.DB.prepare("UPDATE account_signals SET company_id=? WHERE company_id=?").bind(targetId,sourceId),
        env.DB.prepare("UPDATE qualification_alerts SET company_id=? WHERE company_id=?").bind(targetId,sourceId),
        env.DB.prepare("UPDATE deal_activities SET company_id=? WHERE company_id=?").bind(targetId,sourceId),
        env.DB.prepare("UPDATE client_documents SET company_id=?,updated_at=? WHERE company_id=?").bind(targetId,now,sourceId),
        env.DB.prepare("INSERT INTO account_stakeholders(company_id,contact_id,role,notes) SELECT ?,contact_id,role,notes FROM account_stakeholders WHERE company_id=? ON CONFLICT(company_id,contact_id) DO UPDATE SET notes=account_stakeholders.notes||char(10)||excluded.notes").bind(targetId,sourceId),
        env.DB.prepare("DELETE FROM account_stakeholders WHERE company_id=?").bind(sourceId),
        env.DB.prepare("DELETE FROM companies WHERE id=?").bind(sourceId),
      ]);await audit(user,action,"company",targetId,`Merged ${source.name} into ${target.name}`,{sourceId,targetId});
    }else if(action==="repairRelationships"){
      if(!canAdmin(user.role))return Response.json({error:"Admin access is required."},{status:403});const result=await env.DB.prepare("UPDATE deals SET company_id=(SELECT id FROM companies WHERE lower(name)=lower(deals.company) LIMIT 1) WHERE company_id IS NULL AND company<>''").run();await audit(user,action,"deal","bulk","Matched deals to company records",{updated:result.meta.changes});return Response.json({ok:true,updated:result.meta.changes});
    }else if(action==="enrichCompany"){
      const companyId=id(body.companyId),company=await one("SELECT * FROM companies WHERE id=?",companyId);if(!company)throw new Error("Company not found.");let domain=text(company.domain,240).toLowerCase();if(!domain&&company.website){try{domain=new URL(String(company.website)).hostname.replace(/^www\./,"").toLowerCase()}catch{}}if(!domain)throw new Error("Add a company website before enriching the record.");const updated=await env.DB.prepare("UPDATE contacts SET company=?,updated_at=? WHERE company='' AND lower(substr(email,instr(email,'@')+1))=?").bind(String(company.name),now,domain).run();await env.DB.prepare("UPDATE companies SET domain=?,updated_at=? WHERE id=?").bind(domain,now,companyId).run();await audit(user,action,"company",companyId,"Enriched company from its domain",{domain,contactsMatched:updated.meta.changes});return Response.json({ok:true,domain,contactsMatched:updated.meta.changes});
    }else throw new Error("Unknown deal workspace action.");
    return Response.json({ok:true});
  }catch(error){const message=error instanceof Error?error.message:"The change could not be saved.";return Response.json({error:/SQLITE|constraint/i.test(message)?"The change conflicts with an existing or missing record.":message},{status:400})}
}
