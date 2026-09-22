import { env } from "cloudflare:workers";
import { assertAiRunAllowed, beginAiRun, completeAiRun, failAiRun, loadAiSettings, providerConfigured } from "@/lib/ai-governance";
import { audit, can, crmUser, sha256, type CRMUser } from "@/lib/crm-auth";
import { buildDeterministicFollowUpDraft, followUpDraftSchema, normalizeFollowUpDraft, type FollowUpDraft } from "@/lib/follow-up-drafts";

type Row=Record<string,unknown>;
type SourceType="meeting"|"note"|"transcript";
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const identifier=(value:unknown)=>{const result=clean(value,120);if(!result)throw new Error("Choose a source record.");return result};
const dealId=(value:unknown)=>{const result=Number(value);if(!Number.isInteger(result)||result<1)throw new Error("Choose a valid deal.");return result};
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();
const parse=(value:unknown,fallback:unknown={})=>{try{return JSON.parse(String(value??""))}catch{return fallback}};
const denied=(user:CRMUser|null,permission:"ai.view"|"ai.generate"|"ai.review"|"records.edit")=>!user?Response.json({error:"Sign in is required."},{status:401}):!can(user,permission)?Response.json({error:`${permission} permission is required.`},{status:403}):null;

function artifact(row:Row|null){
  if(!row)return null;const entity=String(row.entity_id||"").split(":"),content=normalizeFollowUpDraft(parse(row.content_json));
  return {id:row.id,dealId:Number(entity[0]),sourceType:entity[1],sourceId:entity.slice(2).join(":"),reviewStatus:row.review_status,content,explanation:row.explanation,confidence:Number(row.confidence||0),provider:row.provider,model:row.model,promptVersion:row.prompt_version,rulesVersion:row.rules_version,generatedBy:row.generated_by,generatedAt:row.generated_at,reviewedBy:row.reviewed_by,reviewedAt:row.reviewed_at,sourceCount:Number(row.source_count||0)};
}

async function dealContext(id:number){
  const deal=await one("SELECT d.*,COALESCE(d.company_id,c.id) AS resolved_company_id FROM deals d LEFT JOIN companies c ON c.name=d.company WHERE d.id=?",id);if(!deal)throw new Error("Deal not found.");
  const [company,stakeholders]=await Promise.all([deal.resolved_company_id?one("SELECT * FROM companies WHERE id=?",Number(deal.resolved_company_id)):Promise.resolve(null),rows("SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.email,c.title FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? AND s.active=1 ORDER BY s.is_primary DESC,c.first_name",id)]);
  return {deal,company,stakeholders};
}

async function selectedSource(id:number,type:SourceType,sourceId:string,user:CRMUser,allowSensitive:boolean,maxChars:number){
  if(type==="meeting"){
    const source=await one("SELECT m.*,d.title AS transcript_title FROM deal_meetings m LEFT JOIN client_documents d ON d.id=m.transcript_document_id WHERE m.id=? AND m.deal_id=?",sourceId,id);if(!source)throw new Error("Meeting not found.");
    const attendees=await rows("SELECT a.*,c.first_name||' '||c.last_name AS contact_name,c.title AS contact_title FROM deal_meeting_attendees a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.meeting_id=? ORDER BY a.id",sourceId);return {source:{...source,attendees},label:clean(source.subject,240)||"Meeting",transcriptText:""};
  }
  if(type==="note"){
    const numeric=Number(sourceId);if(!Number.isInteger(numeric)||numeric<1)throw new Error("Note not found.");const source=await one("SELECT * FROM deal_notes WHERE id=? AND deal_id=?",numeric,id);if(!source)throw new Error("Note not found.");return {source,label:`${clean(source.kind,40)||"Note"} · ${clean(source.created_at,40)}`,transcriptText:""};
  }
  const source=await one(`SELECT d.*,v.filename,v.content_type,v.size,v.object_key,v.checksum,v.uploaded_at
    FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version WHERE d.id=? AND d.deal_id=? AND d.status='Active'`,sourceId,id);if(!source)throw new Error("Transcript document not found.");
  if(Boolean(source.sensitive)&&(!can(user,"documents.manage_sensitive")||!allowSensitive))throw new Error("Sensitive transcript content is not allowed by the current AI settings.");
  let transcriptText="";const typeName=clean(source.content_type,120),size=Number(source.size||0);
  if((typeName.startsWith("text/")||typeName==="application/csv")&&size<=Math.min(1_000_000,maxChars*4)){
    const object=await env.BUCKET.get(String(source.object_key));if(object)transcriptText=(await object.text()).slice(0,maxChars);
  }
  return {source,label:clean(source.title,240)||clean(source.filename,240)||"Transcript",transcriptText};
}

function outputText(response:Row){
  if(typeof response.output_text==="string")return response.output_text;
  const output=Array.isArray(response.output)?response.output:[];return output.flatMap(item=>{const row=item as Row;return Array.isArray(row.content)?row.content:[]}).map(item=>{const row=item as Row;return row.type==="output_text"?clean(row.text,30000):""}).join("");
}

async function modelDraft(input:string,settings:Row,prompt:Row|null){
  const key=clean((env as unknown as Record<string,unknown>).OPENAI_API_KEY,1000),system=clean(prompt?.system_prompt,30000)||"Create a concise, professional B2B follow-up draft using only the supplied ClientRecord CRM evidence. Never invent decisions, commitments, owners, or due dates. Use an empty string or data gap when evidence is missing. The user will review this draft; do not claim it was sent.";
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({model:String(settings.model),input:[{role:"system",content:system},{role:"user",content:input}],max_output_tokens:2200,text:{format:{type:"json_schema",name:"clientrecord_follow_up_draft",strict:true,schema:followUpDraftSchema}}})});
  const payload=await response.json() as Row;if(!response.ok)throw new Error(clean((payload.error as Row|undefined)?.message,1200)||`AI provider returned ${response.status}.`);const text=outputText(payload);if(!text)throw new Error("The AI provider returned no draft.");return normalizeFollowUpDraft(JSON.parse(text));
}

async function generate(id:number,type:SourceType,sourceId:string,user:CRMUser,force:boolean){
  const settings=await loadAiSettings(),context=await dealContext(id),selected=await selectedSource(id,type,sourceId,user,Boolean(settings.allowSensitiveSources),Number(settings.maxContextChars)),prompt=await one("SELECT * FROM ai_prompt_versions WHERE feature='follow-up-draft' AND status='Active' ORDER BY version DESC LIMIT 1"),entityId=`${id}:${type}:${sourceId}`;
  const sourceGroups=[
    {type,id:sourceId,updatedAt:clean(selected.source.updated_at||selected.source.uploaded_at||selected.source.created_at),value:{...selected.source,transcriptText:selected.transcriptText},excerpt:selected.label},
    {type:"deal",id:String(id),updatedAt:clean(context.deal.updated_at),value:context.deal,excerpt:`${clean(context.deal.name,240)} · ${clean(context.deal.stage,120)} · ${clean(context.deal.next_step,240)}`},
    ...(context.company?[{type:"company",id:String(context.company.id),updatedAt:clean(context.company.updated_at),value:context.company,excerpt:clean(context.company.name,240)}]:[]),
    {type:"stakeholders",id:context.stakeholders.map(item=>item.id).join(",")||"none",updatedAt:clean(context.stakeholders[0]?.updated_at||context.deal.updated_at),value:context.stakeholders,excerpt:context.stakeholders.map(item=>`${clean(item.contact_name,120)} (${clean(item.role,80)})`).join(", ")},
  ];
  const input=JSON.stringify({instruction:"Draft a human-reviewed follow-up. Use only these records.",sourceType:type,sourceLabel:selected.label,deal:context.deal,company:context.company,stakeholders:context.stakeholders,selectedSource:selected.source,transcriptText:selected.transcriptText}).slice(0,Number(settings.maxContextChars)),hashInput=JSON.stringify({input,promptVersion:Number(prompt?.version||1),model:settings.enabled?settings.model:"follow-up-rules-v1"}),inputHash=await sha256(hashInput);
  if(!force){const cached=await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='follow-up-draft' AND a.entity_type='deal' AND a.entity_id=? AND a.input_hash=? AND a.review_status!='Rejected' ORDER BY a.generated_at DESC LIMIT 1",entityId,inputHash);if(cached)return {artifact:artifact(cached),cached:true,mode:String(cached.provider)==="openai"?"Model-backed":"Source-backed"}}
  let draft:FollowUpDraft,run:null|{id:string;startedAt:number}=null,provider="clientrecord",model="follow-up-rules-v1";
  if(Boolean(settings.enabled)&&providerConfigured()){
    const allowed=await assertAiRunAllowed(user);provider=String(allowed.provider);model=String(allowed.model);run=await beginAiRun({feature:"follow-up-draft",entityType:"deal",entityId,requestedBy:user.email,provider,model,promptVersion:Number(prompt?.version||1),sourceCount:sourceGroups.length,input:hashInput});
    try{draft=await modelDraft(input,allowed,prompt);await completeAiRun(run,JSON.stringify(draft))}catch(error){await failAiRun(run,error);throw error}
  }else draft=buildDeterministicFollowUpDraft({sourceType:type,source:selected.source,deal:context.deal,company:context.company,stakeholders:context.stakeholders,transcriptText:selected.transcriptText});
  if(type==="transcript"&&!selected.transcriptText&&!draft.dataGaps.includes("The transcript file format is not readable as plain text."))draft.dataGaps.push("The transcript file format is not readable as plain text; the draft used document metadata and deal context.");
  const artifactId=crypto.randomUUID(),generatedAt=new Date().toISOString(),confidence=draft.confidence==="High"?90:draft.confidence==="Medium"?70:40,sources=await Promise.all(sourceGroups.map(async source=>({...source,hash:await sha256(JSON.stringify(source.value))})));
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_artifacts SET superseded_by=? WHERE feature='follow-up-draft' AND entity_type='deal' AND entity_id=? AND superseded_by IS NULL").bind(artifactId,entityId),
    env.DB.prepare("INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,review_status,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,rules_version,input_hash,generated_by,generated_at) VALUES (?,?,'follow-up-draft','deal',?,'Draft',?,?,?,?,?,?,?,?,?,?,?)").bind(artifactId,run?.id||null,entityId,JSON.stringify(draft),JSON.stringify(draft),draft.explanation,confidence,provider,model,Number(prompt?.version||1),"follow-up-draft-v1",inputHash,user.email,generatedAt),
    ...sources.map(source=>env.DB.prepare("INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,source_updated_at,content_hash,excerpt) VALUES (?,?,?,?,?,?)").bind(artifactId,source.type,source.id.slice(0,1000),source.updatedAt||null,source.hash,source.excerpt.slice(0,1000))),
  ]);
  await audit(user,"ai.follow_up.generate","ai_artifact",artifactId,"Generated a reviewable follow-up draft",{dealId:id,sourceType:type,sourceId,provider,model,promptVersion:Number(prompt?.version||1)});
  return {artifact:artifact(await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.id=?",artifactId)),cached:false,mode:provider==="openai"?"Model-backed":"Source-backed"};
}

export async function GET(request:Request){
  const user=await crmUser(request),error=denied(user,"ai.view");if(error||!user)return error;
  try{const id=dealId(new URL(request.url).searchParams.get("dealId"));await dealContext(id);const drafts=await rows("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='follow-up-draft' AND a.entity_type='deal' AND a.entity_id LIKE ? AND a.superseded_by IS NULL ORDER BY a.generated_at DESC",`${id}:%`);return Response.json({drafts:drafts.map(item=>artifact(item)),providerConfigured:providerConfigured(),settings:await loadAiSettings(),permissions:{generate:can(user,"ai.generate"),review:can(user,"ai.review"),createTasks:can(user,"records.edit")}})}catch(error){return Response.json({error:error instanceof Error?error.message:"Follow-up drafts could not load."},{status:400})}
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  try{
    const body=await request.json() as Row,action=clean(body.action,60),id=dealId(body.dealId);
    if(action==="generate"){
      const error=denied(user,"ai.generate");if(error)return error;const type=clean(body.sourceType,20) as SourceType;if(!["meeting","note","transcript"].includes(type))throw new Error("Choose a meeting, note, or transcript.");return Response.json(await generate(id,type,identifier(body.sourceId),user,Boolean(body.force)));
    }
    const artifactId=identifier(body.artifactId),record=await one("SELECT * FROM ai_artifacts WHERE id=? AND feature='follow-up-draft' AND entity_type='deal' AND entity_id LIKE ?",artifactId,`${id}:%`);if(!record)throw new Error("Follow-up draft not found.");
    if(action==="review"){
      const error=denied(user,"ai.review");if(error)return error;const status=clean(body.status,20);if(!["Accepted","Edited","Rejected"].includes(status))throw new Error("Choose accepted, edited, or rejected.");let content=String(record.content_json);if(status==="Edited")content=JSON.stringify(normalizeFollowUpDraft(body.content));const before={reviewStatus:record.review_status,content:parse(record.content_json)},after={reviewStatus:status,content:parse(content)};
      await env.DB.batch([env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").bind(artifactId,status,JSON.stringify(before),JSON.stringify(after),clean(body.comment,4000),user.email),env.DB.prepare("UPDATE ai_artifacts SET review_status=?,content_json=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").bind(status,content,user.email,artifactId)]);await audit(user,"ai.follow_up.review","ai_artifact",artifactId,`${status} follow-up draft`,{before,after});return Response.json({ok:true,artifact:artifact(await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.id=?",artifactId))});
    }
    if(action==="createTasks"){
      const error=denied(user,"records.edit");if(error)return error;if(!["Accepted","Edited"].includes(String(record.review_status)))throw new Error("Accept or save edits to the draft before creating tasks.");const selected=Array.isArray(body.selected)?[...new Set(body.selected.map(Number).filter(value=>Number.isInteger(value)&&value>=0))]:[],draft=normalizeFollowUpDraft(parse(record.content_json)),steps=selected.map(index=>draft.nextSteps[index]).filter(Boolean);if(!steps.length)throw new Error("Select at least one next step.");const context=await dealContext(id),created:string[]=[],skipped:string[]=[],fallbackDate=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
      for(const step of steps){const owner=step.owner||clean(context.deal.owner,200)||user.email,dueDate=step.dueDate||fallbackDate,existing=await one("SELECT id FROM deal_tasks WHERE deal_id=? AND lower(title)=lower(?) AND due_date=? AND completed=0",id,step.text,dueDate);if(existing){skipped.push(step.text);continue}await env.DB.prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,completed,created_at) VALUES (?,?,?,?,0,datetime('now'))").bind(id,step.text,owner,dueDate).run();created.push(step.text)}
      await env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,'TasksCreated','{}',?,?,?,datetime('now'))").bind(artifactId,JSON.stringify({selected,created,skipped}),clean(body.comment,4000),user.email).run();await audit(user,"ai.follow_up.tasks","ai_artifact",artifactId,"Created selected tasks from a follow-up draft",{dealId:id,selected,created,skipped});return Response.json({ok:true,created,skipped});
    }
    throw new Error("Unknown follow-up draft action.");
  }catch(error){return Response.json({error:error instanceof Error?error.message:"The follow-up action could not be completed."},{status:400})}
}

