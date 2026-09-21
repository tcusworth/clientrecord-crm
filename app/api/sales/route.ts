import { env } from "cloudflare:workers";
import { canAdmin, canEdit, crmUser } from "@/lib/crm-auth";
import { defaultPipeline, relationshipRoles, signalPoints, validateStages, type Pipeline } from "@/lib/sales-rules";

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
        ORDER BY date DESC LIMIT 150`,accountId,accountId,accountId,accountId);
      return Response.json({timeline});
    }
    const [companies,contacts,stakeholders,deals,tasks,history,signals,alerts,pipe]=await Promise.all([
      rows("SELECT * FROM companies ORDER BY name"),
      rows("SELECT id,first_name||' '||last_name AS name,email,company,title FROM contacts ORDER BY first_name,last_name"),
      rows("SELECT * FROM account_stakeholders"),
      rows("SELECT * FROM deals ORDER BY updated_at DESC"),
      rows("SELECT * FROM deal_tasks ORDER BY completed,due_date"),
      rows("SELECT * FROM deal_stage_history ORDER BY happened_at DESC LIMIT 500"),
      rows("SELECT * FROM account_signals ORDER BY occurred_at DESC"),
      canAdmin(user.role)?rows("SELECT * FROM qualification_alerts ORDER BY created_at DESC LIMIT 100"):rows("SELECT * FROM qualification_alerts WHERE owner=? ORDER BY created_at DESC LIMIT 100",user.email),
      pipelines(),
    ]);
    return Response.json({user,companies,contacts,stakeholders,deals:deals.map(d=>({...d,status:!d.stage_key&&["Won","Lost"].includes(String(d.stage))?d.stage:d.status})),tasks,history,signals,alerts,pipelines:pipe,signalPoints,relationshipRoles});
  }catch(error){console.error(error);return Response.json({error:"Sales foundation could not load."},{status:503});}
}
export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  if(!canEdit(user.role))return Response.json({error:"Editor access is required."},{status:403});
  try{
    const b=await request.json() as Row,action=str(b.action),now=new Date().toISOString();
    if(action==="saveAccount"){
      const name=requireText(b.name,"Company name"),owner=requireText(b.owner,"Owner email").toLowerCase(),fit=number(b.fit_score);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw new Error("Use an email address for the account owner.");
      if(str(b.website)&&!/^https?:\/\//i.test(str(b.website)))throw new Error("Website must start with https:// or http://.");
      if(fit>0&&!str(b.fit_reason))throw new Error("Explain the fit score so qualification remains transparent.");
      const before=await db().prepare("SELECT * FROM companies WHERE name=?").bind(name).first<Row>();
      const tags=JSON.stringify(str(b.tags).split(",").map(s=>s.trim()).filter(Boolean).slice(0,30));
      const result=await db().batch([
        db().prepare("INSERT INTO companies(name,stage,notes,updated_at,website,industry,tier,territory,owner,tags,fit_score,fit_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET stage=excluded.stage,notes=excluded.notes,updated_at=excluded.updated_at,website=excluded.website,industry=excluded.industry,tier=excluded.tier,territory=excluded.territory,owner=excluded.owner,tags=excluded.tags,fit_score=excluded.fit_score,fit_reason=excluded.fit_reason")
          .bind(name,str(b.stage)||"Prospect",str(b.notes),now,str(b.website),str(b.industry),str(b.tier),str(b.territory),owner,tags,fit,str(b.fit_reason)),
        ...(Object.hasOwn(b,"primary_contact_id")?[db().prepare("UPDATE companies SET primary_contact_id=? WHERE name=?").bind(b.primary_contact_id?number(b.primary_contact_id,1,1e12):null,name)]:[]),
        ...recalculate(name,user.email),auditStatement(user.email,action,name,before,b),
      ]);
      const id=before?Number(before.id):Number(result[0].meta.last_row_id);
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
      const changed=!before||before.pipeline_key!==pipe.id||(before.stage_key||before.stage)!==stage.key;
      const params=[name,str(b.company),contact,stage.name,owner,value,stage.probability,next,str(b.close_date)||null,str(b.lead_source)||"Direct",stage.kind,pipe.id,stage.key,stage.kind==="Open"?"":reason,changed?now:String(before?.stage_entered_at||""),now];
      const mutation=id?db().prepare("UPDATE deals SET name=?,company=?,contact_id=?,stage=?,owner=?,value=?,probability=?,next_step=?,close_date=?,lead_source=?,status=?,pipeline_key=?,stage_key=?,closed_reason=?,stage_entered_at=?,updated_at=? WHERE id=?").bind(...params,id):db().prepare("INSERT INTO deals(name,company,contact_id,stage,owner,value,probability,next_step,close_date,lead_source,status,pipeline_key,stage_key,closed_reason,stage_entered_at,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(...params,now);
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
    }else if(action==="completeTask"){
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
