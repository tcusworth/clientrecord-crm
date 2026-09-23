import { env } from "cloudflare:workers";
import { assertAiRunAllowed, beginAiRun, completeAiRun, failAiRun, loadAiSettings, providerConfigured } from "@/lib/ai-governance";
import { buildDeterministicProposalDraft, normalizeProposalDraft, proposalDraftSchema, type ProposalDraft } from "@/lib/ai-proposals";
import { audit, can, crmUser, sha256, type CRMUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const dealId=(value:unknown)=>{const result=Number(value);if(!Number.isInteger(result)||result<1)throw new Error("Choose a valid deal.");return result};
const cents=(value:unknown)=>{const amount=Number(value);if(!Number.isFinite(amount)||amount<0||amount>1e10)throw new Error("Enter a valid proposal amount.");return Math.round(amount*100)};
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();
const parse=(value:unknown,fallback:unknown={})=>{try{return JSON.parse(String(value??""))}catch{return fallback}};
const denied=(user:CRMUser|null,permission:"ai.view"|"ai.generate"|"ai.review"|"records.edit")=>!user?Response.json({error:"Sign in is required."},{status:401}):!can(user,permission)?Response.json({error:`${permission} permission is required.`},{status:403}):null;

function outputText(response:Row){
  if(typeof response.output_text==="string")return response.output_text;
  const output=Array.isArray(response.output)?response.output:[];
  return output.flatMap(item=>{const row=item as Row;return Array.isArray(row.content)?row.content:[]}).map(item=>{const row=item as Row;return row.type==="output_text"?clean(row.text,40000):""}).join("");
}

function artifact(row:Row){
  return {id:String(row.id),reviewStatus:String(row.review_status),content:normalizeProposalDraft(parse(row.content_json)),explanation:clean(row.explanation),confidence:Number(row.confidence||0),provider:String(row.provider),model:String(row.model),promptVersion:Number(row.prompt_version||1),rulesVersion:String(row.rules_version),generatedBy:String(row.generated_by),generatedAt:String(row.generated_at),reviewedBy:row.reviewed_by?String(row.reviewed_by):null,reviewedAt:row.reviewed_at?String(row.reviewed_at):null,sourceCount:Number(row.source_count||0)};
}

async function context(id:number){
  const deal=await one("SELECT d.*,COALESCE(d.company_id,c.id) AS resolved_company_id FROM deals d LEFT JOIN companies c ON c.name=d.company WHERE d.id=?",id);if(!deal)throw new Error("Deal not found.");
  const [company,stakeholders,lineItems,insights,notes,activities,meetings,proposals]=await Promise.all([
    deal.resolved_company_id?one("SELECT * FROM companies WHERE id=?",Number(deal.resolved_company_id)):Promise.resolve(null),
    rows("SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.email,c.title FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? AND s.active=1 ORDER BY s.is_primary DESC,c.first_name",id),
    rows("SELECT *,quantity*unit_price*(100-discount_percent)/100 AS total FROM deal_line_items WHERE deal_id=? ORDER BY id",id),
    rows("SELECT * FROM deal_insights WHERE deal_id=? ORDER BY CASE severity WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,updated_at DESC",id),
    rows("SELECT * FROM deal_notes WHERE deal_id=? ORDER BY pinned DESC,updated_at DESC LIMIT 20",id),
    rows("SELECT * FROM deal_activities WHERE deal_id=? ORDER BY happened_at DESC LIMIT 20",id),
    rows("SELECT * FROM deal_meetings WHERE deal_id=? ORDER BY starts_at DESC LIMIT 12",id),
    rows("SELECT id,title,status,amount,valid_until,updated_at FROM deal_proposals WHERE deal_id=? ORDER BY updated_at DESC LIMIT 8",id),
  ]);
  return {deal,company,stakeholders,lineItems,insights,notes,activities,meetings,proposals};
}

async function modelDraft(input:string,settings:Row,prompt:Row|null){
  const key=clean((env as unknown as Record<string,unknown>).OPENAI_API_KEY,1000),system=clean(prompt?.system_prompt,30000)||"Draft a concise, professional B2B proposal using only the supplied ClientRecord CRM records. Do not invent facts, dates, commitments, pricing, deliverables, legal terms, customer claims, or approvals. Clearly put missing information in dataGaps and use [Confirm …] placeholders in the body where needed. The draft must be human reviewed before sharing.";
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({model:String(settings.model),input:[{role:"system",content:system},{role:"user",content:input}],max_output_tokens:3600,text:{format:{type:"json_schema",name:"clientrecord_proposal_draft",strict:true,schema:proposalDraftSchema}}})});
  const payload=await response.json() as Row;if(!response.ok)throw new Error(clean((payload.error as Row|undefined)?.message,1200)||`AI provider returned ${response.status}.`);const text=outputText(payload);if(!text)throw new Error("The AI provider returned no proposal.");return normalizeProposalDraft(JSON.parse(text));
}

async function generate(id:number,user:CRMUser,force:boolean){
  const settings=await loadAiSettings(),data=await context(id),prompt=await one("SELECT * FROM ai_prompt_versions WHERE feature='proposal-draft' AND status='Active' ORDER BY version DESC LIMIT 1");
  const sourceGroups=[
    {type:"deal",id:String(id),updatedAt:clean(data.deal.updated_at),value:data.deal,excerpt:`${clean(data.deal.name,240)} · ${clean(data.deal.stage,120)}`},
    ...(data.company?[{type:"company",id:String(data.company.id),updatedAt:clean(data.company.updated_at),value:data.company,excerpt:clean(data.company.name,240)}]:[]),
    {type:"stakeholders",id:data.stakeholders.map(item=>item.id).join(",")||"none",updatedAt:clean(data.stakeholders[0]?.updated_at||data.deal.updated_at),value:data.stakeholders,excerpt:data.stakeholders.map(item=>`${clean(item.contact_name,120)} (${clean(item.role,80)})`).join(", ")},
    {type:"line-items",id:data.lineItems.map(item=>item.id).join(",")||"none",updatedAt:clean(data.lineItems[0]?.updated_at||data.deal.updated_at),value:data.lineItems,excerpt:data.lineItems.map(item=>clean(item.name,120)).join(", ")},
    {type:"insights",id:data.insights.map(item=>item.id).join(",")||"none",updatedAt:clean(data.insights[0]?.updated_at||data.deal.updated_at),value:data.insights,excerpt:data.insights.slice(0,5).map(item=>`${clean(item.kind,60)}: ${clean(item.title,120)}`).join("; ")},
    {type:"notes",id:data.notes.map(item=>item.id).join(",")||"none",updatedAt:clean(data.notes[0]?.updated_at||data.deal.updated_at),value:data.notes,excerpt:data.notes.filter(item=>Boolean(item.pinned)).slice(0,4).map(item=>clean(item.body,200)).join("; ")},
    {type:"activities",id:data.activities.map(item=>item.id).join(",")||"none",updatedAt:clean(data.activities[0]?.updated_at||data.deal.updated_at),value:data.activities,excerpt:data.activities.slice(0,5).map(item=>clean(item.subject||item.body,160)).join("; ")},
    {type:"meetings",id:data.meetings.map(item=>item.id).join(",")||"none",updatedAt:clean(data.meetings[0]?.updated_at||data.deal.updated_at),value:data.meetings,excerpt:data.meetings.slice(0,4).map(item=>clean(item.subject,160)).join("; ")},
  ];
  const input=JSON.stringify({instruction:"Create a reviewable proposal draft. Use only the records below.",...data}).slice(0,Number(settings.maxContextChars)),hashInput=JSON.stringify({input,promptVersion:Number(prompt?.version||1),model:settings.enabled?settings.model:"proposal-rules-v1"}),inputHash=await sha256(hashInput);
  if(!force){const cached=await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='proposal-draft' AND a.entity_type='deal' AND a.entity_id=? AND a.input_hash=? AND a.review_status!='Rejected' ORDER BY a.generated_at DESC LIMIT 1",String(id),inputHash);if(cached)return {artifact:artifact(cached),cached:true,mode:String(cached.provider)==="openai"?"Model-backed":"Source-backed"};}
  let draft:ProposalDraft,run:null|{id:string;startedAt:number}=null,provider="clientrecord",model="proposal-rules-v1";
  if(Boolean(settings.enabled)&&providerConfigured()){
    const allowed=await assertAiRunAllowed(user);provider=String(allowed.provider);model=String(allowed.model);run=await beginAiRun({feature:"proposal-draft",entityType:"deal",entityId:id,requestedBy:user.email,provider,model,promptVersion:Number(prompt?.version||1),sourceCount:sourceGroups.length,input:hashInput});
    try{draft=await modelDraft(input,allowed,prompt);await completeAiRun(run,JSON.stringify(draft))}catch(error){await failAiRun(run,error);throw error}
  }else draft=buildDeterministicProposalDraft(data);
  const artifactId=crypto.randomUUID(),generatedAt=new Date().toISOString(),confidence=draft.confidence==="High"?90:draft.confidence==="Medium"?70:40,sources=await Promise.all(sourceGroups.map(async source=>({...source,hash:await sha256(JSON.stringify(source.value))})));
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_artifacts SET superseded_by=? WHERE feature='proposal-draft' AND entity_type='deal' AND entity_id=? AND superseded_by IS NULL").bind(artifactId,String(id)),
    env.DB.prepare("INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,review_status,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,rules_version,input_hash,generated_by,generated_at) VALUES (?,?,'proposal-draft','deal',?,'Draft',?,?,?,?,?,?,?,?,?,?,?)").bind(artifactId,run?.id||null,String(id),JSON.stringify(draft),JSON.stringify(draft),draft.explanation,confidence,provider,model,Number(prompt?.version||1),"proposal-draft-v1",inputHash,user.email,generatedAt),
    ...sources.map(source=>env.DB.prepare("INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,source_updated_at,content_hash,excerpt) VALUES (?,?,?,?,?,?)").bind(artifactId,source.type,source.id,source.updatedAt||null,source.hash,source.excerpt)),
  ]);
  return {artifact:artifact({id:artifactId,review_status:"Draft",content_json:JSON.stringify(draft),explanation:draft.explanation,confidence,provider,model,prompt_version:Number(prompt?.version||1),rules_version:"proposal-draft-v1",generated_by:user.email,generated_at:generatedAt,source_count:sources.length}),cached:false,mode:provider==="openai"?"Model-backed":"Source-backed"};
}

export async function GET(request:Request){
  const user=await crmUser(request),error=denied(user,"ai.view");if(error)return error;try{const id=dealId(new URL(request.url).searchParams.get("dealId")),settings=await loadAiSettings(),drafts=await rows("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='proposal-draft' AND a.entity_type='deal' AND a.entity_id=? ORDER BY a.generated_at DESC LIMIT 12",String(id));return Response.json({drafts:drafts.map(artifact),providerConfigured:providerConfigured(),settings:{enabled:Boolean(settings.enabled)},permissions:{generate:can(user!,"ai.generate")&&can(user!,"records.edit"),review:can(user!,"ai.review"),edit:can(user!,"records.edit")}})}catch(error){return Response.json({error:error instanceof Error?error.message:"AI proposals could not load."},{status:400})}
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});try{
    const body=await request.json() as Row,id=dealId(body.dealId),action=clean(body.action,60),now=new Date().toISOString();
    if(action==="generate"){
      const error=denied(user,"ai.generate")||denied(user,"records.edit");if(error)return error;const result=await generate(id,user,body.force===true);await audit(user,"ai.proposal.generate","ai_artifact",result.artifact.id,result.cached?"Used cached proposal draft":"Generated proposal draft",{dealId:id,cached:result.cached,sourceCount:result.artifact.sourceCount});return Response.json({ok:true,...result});
    }
    const artifactId=clean(body.artifactId,100),record=await one("SELECT * FROM ai_artifacts WHERE id=? AND feature='proposal-draft' AND entity_type='deal' AND entity_id=?",artifactId,String(id));if(!record)throw new Error("Proposal draft not found.");
    if(action==="review"){
      const error=denied(user,"ai.review");if(error)return error;const status=clean(body.status,20);if(!["Accepted","Rejected","Edited"].includes(status))throw new Error("Choose accepted, rejected, or edited.");const before=JSON.stringify({reviewStatus:record.review_status,contentJson:record.content_json}),content=status==="Edited"?normalizeProposalDraft(body.content):normalizeProposalDraft(parse(record.content_json)),after=JSON.stringify({reviewStatus:status,content});await env.DB.batch([env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind(artifactId,status,before,after,clean(body.comment),user.email,now),env.DB.prepare("UPDATE ai_artifacts SET review_status=?,content_json=?,reviewed_by=?,reviewed_at=? WHERE id=?").bind(status,JSON.stringify(content),user.email,now,artifactId)]);await audit(user,"ai.proposal.review","ai_artifact",artifactId,`${status} proposal draft`,{dealId:id,status});return Response.json({ok:true});
    }
    if(action==="saveProposal"){
      const error=denied(user,"records.edit");if(error)return error;const status=String(record.review_status);if(!["Accepted","Edited"].includes(status))throw new Error("Accept the proposal draft or save edits before adding it to the deal.");const draft=normalizeProposalDraft(body.content||parse(record.content_json)),title=clean(body.title||draft.title,240)||"Proposal",amount=cents(body.amount??draft.suggestedAmount/100),validUntil=clean(body.validUntil||draft.validUntil,20)||null,summary=clean(draft.explanation,1000);const result=await env.DB.prepare("INSERT INTO deal_proposals(deal_id,title,amount,status,valid_until,document_id,body_markdown,ai_artifact_id,source_summary,created_by,created_at,updated_at) VALUES (?,?,?,'Draft',?,?,?,?,?,?,?,?)").bind(id,title,amount,validUntil,null,draft.bodyMarkdown,artifactId,summary,user.email,now,now).run();await env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,'ProposalSaved','{}',?,?,?,?)").bind(artifactId,JSON.stringify({proposalId:result.meta.last_row_id,title,amount,validUntil}),clean(body.comment),user.email,now).run();await audit(user,"ai.proposal.save","deal_proposal",result.meta.last_row_id,"Saved AI proposal to deal",{dealId:id,artifactId,title,amount,validUntil});return Response.json({ok:true,proposalId:result.meta.last_row_id});
    }
    throw new Error("Unknown AI proposal action.");
  }catch(error){return Response.json({error:error instanceof Error?error.message:"The AI proposal action could not be completed."},{status:400})}
}
