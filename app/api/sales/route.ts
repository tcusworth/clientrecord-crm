import { env } from "cloudflare:workers";
import { can, canAdmin, crmUser } from "@/lib/crm-auth";
import { defaultPipeline, relationshipRoles, signalPoints, validateStages, type Pipeline } from "@/lib/sales-rules";
import { chooseCompanyDomain, enrichCompanyWebsite, normalizedCompanyDomain } from "@/lib/company-enrichment";

type Row=Record<string,unknown>;
const db=()=>{if(!env.DB)throw new Error("Database is not configured.");return env.DB;};
const str=(v:unknown)=>typeof v==="string"?v.trim():"";
const requireText=(v:unknown,label:string)=>{const s=str(v);if(!s||s.length>4000)throw new Error(label+" is required (maximum 4,000 characters).");return s;};
const number=(v:unknown,min=0,max=100)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw new Error("A numeric value is out of range.");return n;};
const rows=async(sql:string,...args:(string|number|null)[])=>(await db().prepare(sql).bind(...args).all()).results;
async function pipelines():Promise<Pipeline[]> {
  const saved=await rows("SELECT * FROM sales_pipelines ORDER BY name");
  const list=saved.map(r=>({id:String(r.id),name:String(r.name),stages:JSON.parse(String(r.stages))}));
  return list.some(p=>p.id==="default")?list:[defaultPipeline,...list];
}
function auditStatement(email:string,action:string,id:string,before:unknown,after:unknown){
  return db().prepare("INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(email,action,"sales",id,action,JSON.stringify({before,after}),new Date().toISOString());
}
async function customFieldValues(body:Row,entityType:"company"){
  const definitions=await rows("SELECT id,field_type AS fieldType,options FROM custom_field_definitions WHERE entity_type=?",entityType);
  const values:Array<{id:number;value:string}>=[];
  for(const definition of definitions){
    const id=Number(definition.id),key=`customField_${id}`;
    if(!Object.hasOwn(body,key))continue;
    const value=str(body[key]),fieldType=String(definition.fieldType);
    if(value.length>4000)throw new Error("Custom field values are limited to 4,000 characters.");
    if(value&&fieldType==="number"&&!Number.isFinite(Number(value)))throw new Error("Enter a valid number in each number field.");
    if(value&&fieldType==="date"&&!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error("Enter a valid date in each date field.");
    if(value&&fieldType==="boolean"&&!['true','false'].includes(value))throw new Error("Choose Yes or No for each yes/no field.");
    if(value&&fieldType==="select"&&!(JSON.parse(String(definition.options||"[]")) as string[]).includes(value))throw new Error("Choose a configured option for each select field.");
    values.push({id,value});
  }
  return values;
}
// Each recalculation runs in the same transaction as its source edit.
function recalculate(id:number|string,actor:string){
  const selector=typeof id==="number"?"id=?":"name=?";
  const intent="MAX(0,MIN(100,COALESCE((SELECT SUM(points) FROM account_signals WHERE company_id=companies.id AND active=1),0)))";
  const temperature="CASE WHEN "+intent+">=60 AND fit_score>=50 THEN 'Hot' WHEN "+intent+">=20 THEN 'Lukewarm' ELSE 'Cold' END";
  return [
    db().prepare("INSERT INTO qualification_alerts(company_id,owner,message,created_at) SELECT id,CASE WHEN owner='' THEN ? ELSE owner END,name||': '||temperature||' → '||("+temperature+"),? FROM companies WHERE "+selector+" AND temperature<>("+temperature+")").bind(actor,new Date().toISOString(),id),
    db().prepare("UPDATE companies SET intent_score="+intent+",temperature="+temperature+" WHERE "+selector).bind(id),
  ];
}
export async function GET(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  try{
    const accountId=Number(new URL(request.url).searchParams.get("account"));
    if(accountId){
      const timeline=await rows(`SELECT 'activity-'||a.id AS id,a.type AS type,a.note AS summary,a.happened_at AS date,c.first_name||' '||c.last_name AS person FROM activities a JOIN contacts c ON c.id=a.contact_id
        WHERE c.company=(SELECT name FROM companies WHERE id=?) OR c.id IN(SELECT contact_id FROM account_stakeholders WHERE company_id=?)
        UNION ALL SELECT 'signal-'||id,'Signal',kind||': '||summary,occurred_at,actor FROM account_signals WHERE company_id=?
        UNION ALL SELECT 'stage-'||h.id,'Deal stage',d.name||': '||h.from_stage||' → '||h.to_stage,h.happened_at,h.actor FROM deal_stage_history h JOIN deals d ON d.id=h.deal_id WHERE d.company=(SELECT name FROM companies WHERE id=?)
        UNION ALL SELECT 'deal-activity-'||a.id,a.type,d.name||': '||COALESCE(NULLIF(a.subject,''),a.body),a.happened_at,a.owner FROM deal_activities a JOIN deals d ON d.id=a.deal_id WHERE a.company_id=? OR d.company_id=?
        UNION ALL SELECT 'document-'||v.id,'Document',d.title||' · '||d.category,v.uploaded_at,v.uploaded_by FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version WHERE d.company_id=? OR d.deal_id IN(SELECT id FROM deals WHERE company_id=?)
        ORDER BY date DESC LIMIT 150`,accountId,accountId,accountId,accountId,accountId,accountId,accountId,accountId);
      return Response.json({timeline});
    }
    await db().prepare(`INSERT INTO companies(name,updated_at)
      SELECT MIN(trim(c.company)),datetime('now') FROM contacts c
      WHERE trim(c.company)<>'' AND NOT EXISTS(
        SELECT 1 FROM companies existing WHERE lower(existing.name)=lower(trim(c.company))
      ) GROUP BY lower(trim(c.company))`).run();
    const [companies,contacts,stakeholders,deals,tasks,history,signals,alerts,pipe,customFields,customValues]=await Promise.all([
      rows("SELECT * FROM companies ORDER BY name"),
      rows("SELECT id,first_name||' '||last_name AS name,email,company,title FROM contacts ORDER BY first_name,last_name"),
      rows("SELECT * FROM account_stakeholders"),
      rows("SELECT * FROM deals ORDER BY updated_at DESC"),
      rows("SELECT * FROM deal_tasks ORDER BY completed,due_date"),
      rows("SELECT * FROM deal_stage_history ORDER BY happened_at DESC LIMIT 500"),
      rows("SELECT * FROM account_signals ORDER BY occurred_at DESC"),
      canAdmin(user.role)?rows("SELECT * FROM qualification_alerts ORDER BY created_at DESC LIMIT 100"):rows("SELECT * FROM qualification_alerts WHERE owner=? ORDER BY created_at DESC LIMIT 100",user.email),
      pipelines(),
      rows("SELECT id,entity_type AS entityType,name,field_key AS fieldKey,field_type AS fieldType,options FROM custom_field_definitions WHERE entity_type='company' ORDER BY name"),
      rows("SELECT definition_id AS definitionId,entity_type AS entityType,entity_id AS entityId,value FROM custom_field_values WHERE entity_type='company'"),
    ]);
    return Response.json({user,companies,contacts,stakeholders,deals:deals.map(d=>({...d,status:!d.stage_key&&["Won","Lost"].includes(String(d.stage))?d.stage:d.status})),tasks,history,signals,alerts,pipelines:pipe,customFields:customFields.map(field=>({...field,options:JSON.parse(String(field.options||"[]"))})),customFieldValues:customValues,signalPoints,relationshipRoles});
  }catch(error){console.error(error);return Response.json({error:"Sales foundation could not load."},{status:503});}
}
export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  if(!can(user,"records.edit"))return Response.json({error:"Record-edit permission is required."},{status:403});
  try{
    const b=await request.json() as Row,action=str(b.action),now=new Date().toISOString();
    if(action==="previewCompanyEnrichment"){
      const id=number(b.company_id,1,1e12),company=await db().prepare("SELECT id,name,website,domain FROM companies WHERE id=?").bind(id).first<Row>();
      if(!company)throw new Error("Company not found.");
      const emails=await rows("SELECT email FROM contacts WHERE lower(company)=lower(?) AND email<>''",String(company.name));
      const domain=chooseCompanyDomain(company.domain,company.website,emails.map(row=>row.email));
      const proposal=await enrichCompanyWebsite(domain,str(company.website));
      return Response.json({proposal});
    }
    if(action==="applyCompanyEnrichment"){
      const id=number(b.company_id,1,1e12),before=await db().prepare("SELECT * FROM companies WHERE id=?").bind(id).first<Row>();if(!before)throw new Error("Company not found.");
      const supplied=b.fields&&typeof b.fields==="object"&&!Array.isArray(b.fields)?b.fields as Row:{};
      const allowed:Record<string,string>={website:"website",domain:"domain",summary:"summary",industry:"industry",headquarters:"headquarters",linkedin_url:"linkedin_url",logo_url:"logo_url",employee_range:"employee_range"};
      const updates:Array<{column:string;value:string}>=[];
      for(const [key,column] of Object.entries(allowed)){if(!Object.hasOwn(supplied,key))continue;let value=str(supplied[key]);if(["website","linkedin_url","logo_url"].includes(key)&&value&&!/^https?:\/\//i.test(value))throw new Error("Enriched links must start with https:// or http://.");if(key==="domain"&&value){value=normalizedCompanyDomain(value);if(!value)throw new Error("The enriched company domain is invalid.")}updates.push({column,value:value.slice(0,key==="summary"?1200:500)})}
      if(!updates.length)throw new Error("Select at least one enrichment field to apply.");
      const source=str(b.source).slice(0,1000),confidence=number(b.confidence,0,100),setSql=updates.map(item=>`${item.column}=?`).join(",");
      const mutation=db().prepare(`UPDATE companies SET ${setSql},enrichment_source=?,enrichment_confidence=?,enriched_at=?,updated_at=? WHERE id=?`).bind(...updates.map(item=>item.value),source,confidence,now,now,id);
      await db().batch([mutation,auditStatement(user.email,action,String(id),before,{fields:Object.fromEntries(updates.map(item=>[item.column,item.value])),source,confidence})]);
    }else if(action==="saveAccount"){
      const name=requireText(b.name,"Company name"),owner=requireText(b.owner,"Owner email").toLowerCase(),fit=number(b.fit_score);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw new Error("Use an email address for the account owner.");
      if(str(b.website)&&!/^https?:\/\//i.test(str(b.website)))throw new Error("Website must start with https:// or http://.");
      if(fit>0&&!str(b.fit_reason))throw new Error("Explain the fit score so qualification remains transparent.");
      const before=await db().prepare("SELECT * FROM companies WHERE name=?").bind(name).first<Row>();
      const fieldValues=await customFieldValues(b,"company");
      const tags=JSON.stringify(str(b.tags).split(",").map(s=>s.trim()).filter(Boolean).slice(0,30));
      const result=await db().batch([
        db().prepare("INSERT INTO companies(name,stage,notes,updated_at,website,domain,industry,tier,territory,owner,tags,fit_score,fit_reason,summary,headquarters,linkedin_url,logo_url,employee_range) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET stage=excluded.stage,notes=excluded.notes,updated_at=excluded.updated_at,website=excluded.website,domain=excluded.domain,industry=excluded.industry,tier=excluded.tier,territory=excluded.territory,owner=excluded.owner,tags=excluded.tags,fit_score=excluded.fit_score,fit_reason=excluded.fit_reason,summary=excluded.summary,headquarters=excluded.headquarters,linkedin_url=excluded.linkedin_url,logo_url=excluded.logo_url,employee_range=excluded.employee_range")
          .bind(name,str(b.stage)||"Prospect",str(b.notes),now,str(b.website),str(b.domain).toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").replace(/\/$/,""),str(b.industry),str(b.tier),str(b.territory),owner,tags,fit,str(b.fit_reason),str(b.summary),str(b.headquarters),str(b.linkedin_url),str(b.logo_url),str(b.employee_range)),
        ...(Object.hasOwn(b,"primary_contact_id")?[db().prepare("UPDATE companies SET primary_contact_id=? WHERE name=?").bind(b.primary_contact_id?number(b.primary_contact_id,1,1e12):null,name)]:[]),
        ...recalculate(name,user.email),auditStatement(user.email,action,name,before,b),
      ]);
      const id=before?Number(before.id):Number(result[0].meta.last_row_id);
      if(fieldValues.length){
        const changes=fieldValues.flatMap(field=>[
          db().prepare("DELETE FROM custom_field_values WHERE definition_id=? AND entity_type='company' AND entity_id=?").bind(field.id,id),
          ...(field.value?[db().prepare("INSERT INTO custom_field_values(definition_id,entity_type,entity_id,value,updated_at) VALUES (?,'company',?,?,?)").bind(field.id,id,field.value,now)]:[]),
        ]);
        await db().batch(changes);
      }
      return Response.json({id});
    }
    if(action==="saveStakeholder"){
      const company=number(b.company_id,1,1e12),contact=number(b.contact_id,1,1e12),role=str(b.role);
      if(!relationshipRoles.includes(role))throw new Error("Choose a valid relationship role.");
      const before=await db().prepare("SELECT * FROM account_stakeholders WHERE company_id=? AND contact_id=?").bind(company,contact).first();
      await db().batch([db().prepare("INSERT INTO account_stakeholders(company_id,contact_id,role,notes) VALUES (?,?,?,?) ON CONFLICT(company_id,contact_id) DO UPDATE SET role=excluded.role,notes=excluded.notes").bind(company,contact,role,str(b.notes)),auditStatement(user.email,action,String(company),before,b)]);
    }else if(action==="removeStakeholder"){
      const before=await db().prepare("SELECT * FROM account_stakeholders WHERE id=?").bind(number(b.id,1,1e12)).first();
      await db().batch([db().prepare("DELETE FROM account_stakeholders WHERE id=?").bind(b.id),auditStatement(user.email,action,String(b.id),before,null)]);
    }else if(action==="saveSignal"||action==="withdrawSignal"){
      let company:number;
      let mutation:D1PreparedStatement;
      let before:unknown=null;
      if(action==="saveSignal"){
        company=number(b.company_id,1,1e12);
        const kind=str(b.kind);if(!Object.hasOwn(signalPoints,kind))throw new Error("Choose a valid signal type.");
        const occurred=str(b.occurred_at),time=Date.parse(occurred);
        if(!Number.isFinite(time)||time>Date.now()+86400000)throw new Error("Choose a valid signal date that is not in the future.");
        mutation=db().prepare("INSERT INTO account_signals(id,company_id,kind,summary,evidence,points,occurred_at,created_at,actor) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),company,kind,requireText(b.summary,"Summary"),requireText(b.evidence,"Evidence or source"),signalPoints[kind],new Date(time).toISOString(),now,user.email);
      }else{
        before=await db().prepare("SELECT * FROM account_signals WHERE id=?").bind(str(b.id)).first<Row>();
        if(!before)throw new Error("Signal not found.");
        company=Number((before as Row).company_id);
        mutation=db().prepare("UPDATE account_signals SET active=0 WHERE id=?").bind(str(b.id));
      }
      await db().batch([mutation,...recalculate(company,user.email),auditStatement(user.email,action,String(company),before,b)]);
    }else if(action==="readAlert"){
      await db().prepare("UPDATE qualification_alerts SET read_at=? WHERE id=? AND (owner=? OR ?=1)").bind(now,number(b.id,1,1e12),user.email,canAdmin(user.role)?1:0).run();
    }else if(action==="savePipeline"){
      if(!canAdmin(user.role))return Response.json({error:"Admin access is required."},{status:403});
      const id=str(b.id)||crypto.randomUUID(),name=requireText(b.name,"Pipeline name"),stages=validateStages(b.stages);
      const before=(await pipelines()).find(p=>p.id===id);
      const existing=await rows("SELECT id,stage_key,stage FROM deals WHERE pipeline_key=?",id);
      if(existing.some(d=>!stages.some(s=>s.key===(d.stage_key||d.stage))))throw new Error("Move deals out of a stage before removing it.");
      if(before&&stages.some(s=>before.stages.some(old=>old.key===s.key&&old.kind!==s.kind)))throw new Error("An existing stage cannot change outcome type. Add a new stage instead.");
      await db().batch([
        db().prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,stages=excluded.stages,updated_at=excluded.updated_at").bind(id,name,JSON.stringify(stages),now),
        ...stages.map(s=>db().prepare("UPDATE deals SET stage_key=?,stage=?,probability=?,status=? WHERE pipeline_key=? AND COALESCE(stage_key,stage)=?").bind(s.key,s.name,s.probability,s.kind,id,s.key)),
        auditStatement(user.email,action,id,before,{name,stages}),
      ]);
    }else if(action==="saveDeal"){
      const id=b.id?number(b.id,1,1e12):0,before=id?await db().prepare("SELECT * FROM deals WHERE id=?").bind(id).first<Row>():null;
      if(id&&!before)throw new Error("Deal not found.");
      const pipe=(await pipelines()).find(p=>p.id===str(b.pipeline_key));
      const stage=pipe?.stages.find(s=>s.key===str(b.stage_key));
      if(!pipe||!stage)throw new Error("Choose a pipeline and one of its stages.");
      const name=requireText(b.name,"Deal name"),owner=requireText(b.owner,"Owner"),reason=str(b.closed_reason),next=str(b.next_step);
      if(stage.kind!=="Open"&&!reason)throw new Error("A won/lost reason is required.");
      if(stage.kind==="Open"&&!next)throw new Error("Open deals need a next action.");
      const value=Math.round(number(b.value,0,1e10)*100),contact=b.contact_id?number(b.contact_id,1,1e12):null;
      let companyId=b.company_id?number(b.company_id,1,1e12):null,company:{id?:number;name:string}|null=companyId?await db().prepare("SELECT name FROM companies WHERE id=?").bind(companyId).first<{name:string}>():null;
      // Preserve compatibility with older clients while converting the stored name into a durable relationship.
      if(!companyId&&str(b.company)){company=await db().prepare("SELECT id,name FROM companies WHERE lower(name)=lower(?) LIMIT 1").bind(str(b.company)).first<{id:number;name:string}>();if(company)companyId=company.id}
      if(companyId&&!company)throw new Error("Choose an existing company record.");
      if(companyId&&contact&&!(await db().prepare("SELECT c.id FROM contacts c WHERE c.id=? AND (lower(trim(coalesce(c.company,'')))=lower(trim(?)) OR EXISTS (SELECT 1 FROM account_stakeholders s WHERE s.company_id=? AND s.contact_id=c.id)) LIMIT 1").bind(contact,company!.name,companyId).first()))throw new Error("Choose a contact associated with the selected company.");
      const required=stage.requiredFields||[];
      if(required.includes("company")&&!companyId)throw new Error(`${stage.name} requires a company.`);
      if(required.includes("contact")&&!contact)throw new Error(`${stage.name} requires a primary contact.`);
      if(required.includes("value")&&!value)throw new Error(`${stage.name} requires a deal value.`);
      if(required.includes("closeDate")&&!str(b.close_date))throw new Error(`${stage.name} requires an expected close date.`);
      if(required.includes("nextStep")&&!next)throw new Error(`${stage.name} requires a next action.`);
      if(required.includes("products")&&(!id||!(await db().prepare("SELECT id FROM deal_line_items WHERE deal_id=? LIMIT 1").bind(id).first())))throw new Error(`${stage.name} requires at least one product or line item. Save the deal in an earlier stage, add products, then advance it.`);
      if(required.includes("decisionCriteria")&&(!id||!(await db().prepare("SELECT id FROM deal_insights WHERE deal_id=? AND kind='Decision criterion' LIMIT 1").bind(id).first())))throw new Error(`${stage.name} requires documented decision criteria.`);
      if(required.includes("approval")&&(!id||!(await db().prepare("SELECT id FROM deal_reviews WHERE deal_id=? AND status='Approved' LIMIT 1").bind(id).first())))throw new Error(`${stage.name} requires an approved deal review.`);
      const changed=!before||before.pipeline_key!==pipe.id||(before.stage_key||before.stage)!==stage.key;
      const params=[name,company?.name||"",companyId,contact,stage.name,owner,value,stage.probability,next,str(b.close_date)||null,str(b.lead_source)||"Direct",str(b.campaign),str(b.partner),str(b.forecast_category)||"Pipeline",stage.kind,pipe.id,stage.key,stage.kind==="Open"?"":reason,changed?now:String(before?.stage_entered_at||""),now];
      const mutation=id?db().prepare("UPDATE deals SET name=?,company=?,company_id=?,contact_id=?,stage=?,owner=?,value=?,probability=?,next_step=?,close_date=?,lead_source=?,campaign=?,partner=?,forecast_category=?,status=?,pipeline_key=?,stage_key=?,closed_reason=?,stage_entered_at=?,updated_at=? WHERE id=?").bind(...params,id):db().prepare("INSERT INTO deals(name,company,company_id,contact_id,stage,owner,value,probability,next_step,close_date,lead_source,campaign,partner,forecast_category,status,pipeline_key,stage_key,closed_reason,stage_entered_at,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...params,now);
      // last_insert_rowid refers to the preceding deal insert inside this transaction.
      const history=db().prepare("INSERT INTO deal_stage_history(deal_id,from_stage,to_stage,from_pipeline,to_pipeline,reason,actor,happened_at) VALUES ("+(id?"?":"last_insert_rowid()")+",?,?,?,?,?,?,?)").bind(...(id?[id]:[]),String(before?.stage||"Created"),stage.name,String(before?.pipeline_key||""),pipe.id,reason,user.email,now);
      await db().batch([mutation,...(changed?[history]:[]),auditStatement(user.email,action,String(id||"new"),before,b)]);
      if(changed&&contact){
        await db().prepare("INSERT INTO automation_enrollments(sequence_id,contact_id,current_step,status,next_run_at,enrolled_at) SELECT s.id,?,0,'Active',datetime('now','+'||COALESCE((SELECT delay_days FROM automation_steps WHERE sequence_id=s.id ORDER BY step_order LIMIT 1),0)||' days'),? FROM automation_sequences s WHERE s.active=1 AND s.trigger_type='Deal stage' AND lower(s.trigger_value)=lower(?) AND NOT EXISTS(SELECT 1 FROM automation_enrollments e WHERE e.sequence_id=s.id AND e.contact_id=? AND e.status='Active')").bind(contact,now,stage.name,contact).run();
      }
    }else if(action==="saveTask"){
      const id=number(b.deal_id,1,1e12),due=requireText(b.due_date,"Due date");
      if(!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due)))throw new Error("Choose a valid due date.");
      await db().batch([db().prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,created_at) VALUES (?,?,?,?,?)").bind(id,requireText(b.title,"Task title"),requireText(b.owner,"Task owner"),due,now),auditStatement(user.email,action,String(id),null,b)]);
    }else if(action==="completeTask"||action==="toggleDealTask"){
      const before=await db().prepare("SELECT * FROM deal_tasks WHERE id=?").bind(number(b.id,1,1e12)).first();
      await db().batch([db().prepare("UPDATE deal_tasks SET completed=? WHERE id=?").bind(b.completed?1:0,b.id),auditStatement(user.email,action,String(b.id),before,b)]);
    }else throw new Error("Unknown sales action.");
    return Response.json({ok:true});
  }catch(error){
    console.error(error);
    const message=error instanceof Error?error.message:"The change could not be saved.";
    return Response.json({error:/D1|SQLITE|constraint/i.test(message)?"The record conflicts with existing data or references a missing record. Refresh and try again.":message},{status:400});
  }
}
