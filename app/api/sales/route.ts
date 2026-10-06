import { env } from "cloudflare:workers";
import { audit, can, canAdmin, crmUser } from "@/lib/crm-auth";
import { relationshipRoles, signalPoints, validateStages } from "@/lib/sales-rules";
import { recalculateCompany, saveCompany } from "@/lib/services/companies";
import { createDealTask, pipelines, saveDeal, setDealTaskCompleted } from "@/lib/services/deals";
import { ServiceError } from "@/lib/services/errors";
import { chooseCompanyDomain, enrichCompanyApollo, enrichCompanyWebsite, normalizedCompanyDomain } from "@/lib/company-enrichment";

type Row=Record<string,unknown>;
const db=()=>{if(!env.DB)throw new Error("Database is not configured.");return env.DB;};
const str=(v:unknown)=>typeof v==="string"?v.trim():"";
const requireText=(v:unknown,label:string)=>{const s=str(v);if(!s||s.length>4000)throw new Error(label+" is required (maximum 4,000 characters).");return s;};
const number=(v:unknown,min=0,max=100)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw new Error("A numeric value is out of range.");return n;};
const rows=async(sql:string,...args:(string|number|null)[])=>(await db().prepare(sql).bind(...args).all()).results;
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
export async function GET(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  if(!can(user,"records.view"))return Response.json({error:"View access is required."},{status:403});
  try{
    const accountId=Number(new URL(request.url).searchParams.get("account"));
    if(accountId){
      const timeline=await rows(`SELECT 'activity-'||a.id AS id,a.type AS type,a.note AS summary,a.happened_at AS date,c.first_name||' '||c.last_name AS person FROM activities a JOIN contacts c ON c.id=a.contact_id
        WHERE c.company=(SELECT name FROM companies WHERE id=?) OR c.id IN(SELECT contact_id FROM account_stakeholders WHERE company_id=?)
        UNION ALL SELECT 'signal-'||id,'Signal',kind||': '||summary,occurred_at,actor FROM account_signals WHERE company_id=?
        UNION ALL SELECT 'stage-'||h.id,'Deal stage',d.name||': '||h.from_stage||' → '||h.to_stage,h.happened_at,h.actor FROM deal_stage_history h JOIN deals d ON d.id=h.deal_id WHERE d.company=(SELECT name FROM companies WHERE id=?)
        UNION ALL SELECT 'deal-activity-'||a.id,a.type,d.name||': '||COALESCE(NULLIF(a.subject,''),a.body),a.happened_at,a.owner FROM deal_activities a JOIN deals d ON d.id=a.deal_id WHERE a.company_id=? OR d.company_id=?
        UNION ALL SELECT 'document-'||v.id,'Document',d.title||' · '||d.category,v.uploaded_at,v.uploaded_by FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version WHERE (d.company_id=? OR d.deal_id IN(SELECT id FROM deals WHERE company_id=?)) AND (?=1 OR d.sensitive=0)
        ORDER BY date DESC LIMIT 150`,accountId,accountId,accountId,accountId,accountId,accountId,accountId,accountId,can(user,"documents.manage_sensitive")?1:0);
      return Response.json({timeline});
    }
    // Read-only: companies are reconciled from contact company names on contact writes (lib/crm-records.ts), not here.
    // Companies/contacts are paged or searched via GET /api/crm?resource=companies|company|search instead of shipped in bulk.
    const [stakeholders,deals,tasks,history,signals,alerts,pipe,customFields,customValues]=await Promise.all([
      rows("SELECT * FROM account_stakeholders"),
      rows("SELECT d.*,CASE WHEN d.company_id IS NULL AND trim(d.company)<>'' THEN (SELECT c.id FROM companies c WHERE lower(c.name)=lower(trim(d.company)) LIMIT 1) END AS resolved_company_id FROM deals d ORDER BY d.updated_at DESC"),
      rows("SELECT * FROM deal_tasks ORDER BY completed,due_date"),
      rows("SELECT * FROM deal_stage_history ORDER BY happened_at DESC LIMIT 500"),
      rows("SELECT * FROM account_signals ORDER BY occurred_at DESC"),
      canAdmin(user.role)?rows("SELECT * FROM qualification_alerts ORDER BY created_at DESC LIMIT 100"):rows("SELECT * FROM qualification_alerts WHERE owner=? ORDER BY created_at DESC LIMIT 100",user.email),
      pipelines(db()),
      rows("SELECT id,entity_type AS entityType,name,field_key AS fieldKey,field_type AS fieldType,options FROM custom_field_definitions WHERE entity_type='company' ORDER BY name"),
      rows("SELECT definition_id AS definitionId,entity_type AS entityType,entity_id AS entityId,value FROM custom_field_values WHERE entity_type='company'"),
    ]);
    return Response.json({user,stakeholders,deals:deals.map(d=>({...d,status:!d.stage_key&&["Won","Lost"].includes(String(d.stage))?d.stage:d.status})),tasks,history,signals,alerts,pipelines:pipe,customFields:customFields.map(field=>({...field,options:JSON.parse(String(field.options||"[]"))})),customFieldValues:customValues,signalPoints,relationshipRoles,apolloConfigured:Boolean(String(env.APOLLO_API_KEY||"").trim())});
  }catch(error){console.error(error);return Response.json({error:"Sales foundation could not load."},{status:503});}
}
export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  try{
    const b=await request.json() as Row,action=str(b.action),now=new Date().toISOString();
    if(!can(user,action==="deleteCompany"?"records.delete":"records.edit"))return Response.json({error:action==="deleteCompany"?"Record-delete permission is required.":"Record-edit permission is required."},{status:403});
    if(action==="previewCompanyEnrichment"){
      const id=number(b.company_id,1,1e12),company=await db().prepare("SELECT id,name,website,domain FROM companies WHERE id=?").bind(id).first<Row>();
      if(!company)throw new Error("Company not found.");
      const emails=await rows("SELECT email FROM contacts WHERE lower(company)=lower(?) AND email<>''",String(company.name));
      const domain=chooseCompanyDomain(company.domain,company.website,emails.map(row=>row.email));
      const proposal=await enrichCompanyWebsite(domain,str(company.website));
      return Response.json({proposal});
    }
    if(action==="previewApolloCompanyEnrichment"){
      const id=number(b.company_id,1,1e12),company=await db().prepare("SELECT id,name,website,domain,linkedin_url FROM companies WHERE id=?").bind(id).first<Row>();
      if(!company)throw new Error("Company not found.");
      const emails=await rows("SELECT email FROM contacts WHERE lower(company)=lower(?) AND email<>''",String(company.name));
      const domain=chooseCompanyDomain(company.domain,company.website,emails.map(row=>row.email));
      const apiKey=String(env.APOLLO_API_KEY||"");
      const proposal=await enrichCompanyApollo(apiKey,{name:String(company.name),domain,website:str(company.website),linkedinUrl:str(company.linkedin_url)});
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
      await db().batch([mutation]);await audit(user,action,"sales",String(id),action,{before,after:{fields:Object.fromEntries(updates.map(item=>[item.column,item.value])),source,confidence}});
      return Response.json({ok:true});
    }else if(action==="deleteCompany"){
      const id=number(b.company_id,1,1e12),before=await db().prepare("SELECT * FROM companies WHERE id=?").bind(id).first<Row>();
      if(!before)throw new Error("Company not found.");
      await db().batch([
        db().prepare("UPDATE contacts SET company='',updated_at=datetime('now') WHERE lower(trim(company))=lower(trim(?))").bind(String(before.name)),
        db().prepare("UPDATE deals SET company='',company_id=NULL,updated_at=? WHERE company_id=?").bind(now,id),
        db().prepare("UPDATE deal_activities SET company_id=NULL,updated_at=? WHERE company_id=?").bind(now,id),
        db().prepare("UPDATE deal_meetings SET company_id=NULL,updated_at=? WHERE company_id=?").bind(now,id),
        db().prepare("UPDATE client_documents SET company_id=NULL,updated_at=? WHERE company_id=?").bind(now,id),
        db().prepare("DELETE FROM account_stakeholders WHERE company_id=?").bind(id),
        db().prepare("DELETE FROM account_signals WHERE company_id=?").bind(id),
        db().prepare("DELETE FROM qualification_alerts WHERE company_id=?").bind(id),
        db().prepare("DELETE FROM custom_field_values WHERE entity_type='company' AND entity_id=?").bind(id),
        db().prepare("DELETE FROM ai_record_fields WHERE entity_type='company' AND entity_id=?").bind(id),
        db().prepare("DELETE FROM companies WHERE id=?").bind(id),
      ]);await audit(user,action,"sales",String(id),action,{before,after:{retained:"Contacts, deals, documents and historical activity were unlinked."}});
      return Response.json({ok:true});
    }else if(action==="saveAccount"){
      const fieldValues=await customFieldValues(b,"company");
      const {id,before}=await saveCompany(db(),{name:str(b.name),owner:str(b.owner),stage:str(b.stage),notes:str(b.notes),website:str(b.website),domain:str(b.domain),industry:str(b.industry),tier:str(b.tier),territory:str(b.territory),tags:str(b.tags).split(","),fit_score:Number(b.fit_score),fit_reason:str(b.fit_reason),summary:str(b.summary),headquarters:str(b.headquarters),linkedin_url:str(b.linkedin_url),logo_url:str(b.logo_url),employee_range:str(b.employee_range),...(Object.hasOwn(b,"primary_contact_id")?{primary_contact_id:b.primary_contact_id?number(b.primary_contact_id,1,1e12):null}:{})},user.email,now);
      await audit(user,action,"sales",str(b.name),action,{before,after:b});
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
      await db().batch([db().prepare("INSERT INTO account_stakeholders(company_id,contact_id,role,notes) VALUES (?,?,?,?) ON CONFLICT(company_id,contact_id) DO UPDATE SET role=excluded.role,notes=excluded.notes").bind(company,contact,role,str(b.notes))]);await audit(user,action,"sales",String(company),action,{before,after:b});
    }else if(action==="removeStakeholder"){
      const before=await db().prepare("SELECT * FROM account_stakeholders WHERE id=?").bind(number(b.id,1,1e12)).first();
      await db().batch([db().prepare("DELETE FROM account_stakeholders WHERE id=?").bind(b.id)]);await audit(user,action,"sales",String(b.id),action,{before,after:null});
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
      await db().batch([mutation,...recalculateCompany(db(),company,user.email)]);await audit(user,action,"sales",String(company),action,{before,after:b});
    }else if(action==="readAlert"){
      await db().prepare("UPDATE qualification_alerts SET read_at=? WHERE id=? AND (owner=? OR ?=1)").bind(now,number(b.id,1,1e12),user.email,canAdmin(user.role)?1:0).run();
    }else if(action==="savePipeline"){
      if(!canAdmin(user.role))return Response.json({error:"Admin access is required."},{status:403});
      const id=str(b.id)||crypto.randomUUID(),name=requireText(b.name,"Pipeline name"),stages=validateStages(b.stages);
      const before=(await pipelines(db())).find(p=>p.id===id);
      const existing=await rows("SELECT id,stage_key,stage FROM deals WHERE pipeline_key=?",id);
      if(existing.some(d=>!stages.some(s=>s.key===(d.stage_key||d.stage))))throw new Error("Move deals out of a stage before removing it.");
      if(before&&stages.some(s=>before.stages.some(old=>old.key===s.key&&old.kind!==s.kind)))throw new Error("An existing stage cannot change outcome type. Add a new stage instead.");
      await db().batch([
        db().prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,stages=excluded.stages,updated_at=excluded.updated_at").bind(id,name,JSON.stringify(stages),now),
        ...stages.map(s=>db().prepare("UPDATE deals SET stage_key=?,stage=?,probability=?,status=? WHERE pipeline_key=? AND COALESCE(stage_key,stage)=?").bind(s.key,s.name,s.probability,s.kind,id,s.key)),
      ]);await audit(user,action,"sales",id,action,{before,after:{name,stages}});
    }else if(action==="saveDeal"){
      const saved=await saveDeal(db(),{id:b.id?number(b.id,1,1e12):undefined,name:str(b.name),owner:str(b.owner),pipeline_key:str(b.pipeline_key),stage_key:str(b.stage_key),value:Number(b.value),contact_id:b.contact_id?number(b.contact_id,1,1e12):null,company_id:b.company_id?number(b.company_id,1,1e12):null,company:str(b.company),close_date:str(b.close_date),next_step:str(b.next_step),closed_reason:str(b.closed_reason),lead_source:str(b.lead_source),campaign:str(b.campaign),partner:str(b.partner),forecast_category:str(b.forecast_category)},user.email,now);
      await audit(user,action,"sales",String(saved.id),action,{before:saved.before,after:b});
    }else if(action==="saveTask"){
      const id=number(b.deal_id,1,1e12);await createDealTask(db(),{dealId:id,title:str(b.title),owner:str(b.owner),dueDate:str(b.due_date),now});await audit(user,action,"sales",String(id),action,{before:null,after:b});
    }else if(action==="completeTask"||action==="toggleDealTask"){
      const before=await db().prepare("SELECT * FROM deal_tasks WHERE id=?").bind(number(b.id,1,1e12)).first();
      await setDealTaskCompleted(db(),Number(b.id),Boolean(b.completed));await audit(user,action,"sales",String(b.id),action,{before,after:b});
    }else throw new Error("Unknown sales action.");
    return Response.json({ok:true});
  }catch(error){
    if(error instanceof ServiceError)return Response.json({error:error.message},{status:error.status});
    console.error(error);
    const message=error instanceof Error?error.message:"The change could not be saved.";
    return Response.json({error:/D1|SQLITE|constraint/i.test(message)?"The record conflicts with existing data or references a missing record. Refresh and try again.":message},{status:400});
  }
}
