import { env } from "cloudflare:workers";
import { assertAiRunAllowed, beginAiRun, completeAiRun, failAiRun, loadAiSettings, providerConfigured } from "@/lib/ai-governance";
import { buildDealReview, buildForecastExplanation, dealReviewSchema, forecastExplanationSchema, normalizeDealReview, normalizeForecastExplanation } from "@/lib/ai-revenue-intelligence";
import { audit, can, crmUser, sha256, type CRMUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
type Feature="deal-review"|"forecast-explanation";
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();
const parse=(value:unknown,fallback:unknown={})=>{try{return JSON.parse(String(value??""))}catch{return fallback}};
const id=(value:unknown)=>{const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error("Choose a valid deal.");return number};
const denied=(user:CRMUser|null,permission:"ai.view"|"ai.generate"|"ai.review")=>!user?Response.json({error:"Sign in is required."},{status:401}):!can(user,permission)?Response.json({error:`${permission} permission is required.`},{status:403}):null;

function outputText(response:Row){
  if(typeof response.output_text==="string")return response.output_text;
  return (Array.isArray(response.output)?response.output:[]).flatMap(item=>{const row=item as Row;return Array.isArray(row.content)?row.content:[]}).map(item=>{const row=item as Row;return row.type==="output_text"?clean(row.text,40000):""}).join("");
}
function present(feature:Feature,row:Row){
  const content=feature==="deal-review"?normalizeDealReview(parse(row.content_json)):normalizeForecastExplanation(parse(row.content_json));
  return {id:String(row.id),entityId:clean(row.entity_id,120),reviewStatus:String(row.review_status),content,explanation:clean(row.explanation),confidence:Number(row.confidence||0),provider:clean(row.provider),model:clean(row.model),promptVersion:Number(row.prompt_version||1),rulesVersion:clean(row.rules_version),generatedBy:clean(row.generated_by),generatedAt:clean(row.generated_at),reviewedBy:row.reviewed_by?clean(row.reviewed_by):null,reviewedAt:row.reviewed_at?clean(row.reviewed_at):null,sourceCount:Number(row.source_count||0)};
}
async function dealData(dealId:number){
  const deal=await one("SELECT * FROM deals WHERE id=?",dealId);if(!deal)throw new Error("Deal not found.");
  const [stageHistory,activities,meetings,tasks,insights,stakeholders,relationship,recommendation,aiFields]=await Promise.all([
    rows("SELECT * FROM deal_stage_history WHERE deal_id=? ORDER BY happened_at DESC LIMIT 20",dealId),
    rows("SELECT * FROM deal_activities WHERE deal_id=? ORDER BY happened_at DESC LIMIT 20",dealId),
    rows("SELECT * FROM deal_meetings WHERE deal_id=? ORDER BY starts_at DESC LIMIT 12",dealId),
    rows("SELECT * FROM deal_tasks WHERE deal_id=? ORDER BY completed,due_date LIMIT 30",dealId),
    rows("SELECT * FROM deal_insights WHERE deal_id=? ORDER BY updated_at DESC LIMIT 20",dealId),
    rows("SELECT s.*,c.first_name||' '||c.last_name AS contact_name FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? ORDER BY s.active DESC,s.is_primary DESC",dealId),
    one("SELECT * FROM deal_relationship_health_scores WHERE deal_id=? ORDER BY calculated_at DESC LIMIT 1",dealId),
    one("SELECT * FROM deal_recommendations WHERE deal_id=? AND status='Active' ORDER BY priority ASC,generated_at DESC LIMIT 1",dealId),
    rows("SELECT * FROM ai_record_fields WHERE entity_type='deal' AND entity_id=?",String(dealId)),
  ]);
  return {deal,stageHistory,activities,meetings,tasks,insights,stakeholders,relationship,recommendation,aiFields};
}
async function forecastData(){
  const [deals,stageHistory]=await Promise.all([
    rows("SELECT * FROM deals WHERE status='Open' ORDER BY value DESC LIMIT 300"),
    rows("SELECT h.*,d.name AS deal_name FROM deal_stage_history h JOIN deals d ON d.id=h.deal_id WHERE h.happened_at>=datetime('now','-30 days') ORDER BY h.happened_at DESC LIMIT 150"),
  ]);return {deals,stageHistory};
}
async function modelResult(feature:Feature,input:string,settings:Row,prompt:Row|null){
  const key=clean((env as unknown as Record<string,unknown>).OPENAI_API_KEY,1000),isDeal=feature==="deal-review",schema=isDeal?dealReviewSchema:forecastExplanationSchema;
  const fallback=isDeal?"Create a concise weekly deal review using only supplied ClientRecord CRM records. Do not invent events, customer intent, dates, commitments, or forecast outcomes. Distinguish facts from missing data and make actions specific.":"Explain the CRM forecast using only supplied ClientRecord records. Do not invent historical performance or predict revenue. Identify evidence, uncertainty, and concrete actions.";
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({model:String(settings.model),input:[{role:"system",content:clean(prompt?.system_prompt,30000)||fallback},{role:"user",content:input}],max_output_tokens:2600,text:{format:{type:"json_schema",name:isDeal?"clientrecord_deal_review":"clientrecord_forecast_explanation",strict:true,schema}}})});
  const payload=await response.json() as Row;if(!response.ok)throw new Error(clean((payload.error as Row|undefined)?.message,1200)||`AI provider returned ${response.status}.`);const result=outputText(payload);if(!result)throw new Error("The AI provider returned no result.");return isDeal?normalizeDealReview(JSON.parse(result)):normalizeForecastExplanation(JSON.parse(result));
}
async function generate(feature:Feature,user:CRMUser,dealId?:number,force=false){
  const settings=await loadAiSettings(),data=feature==="deal-review"?await dealData(dealId!):await forecastData(),entityType=feature==="deal-review"?"deal":"forecast",entityId=feature==="deal-review"?String(dealId):"current",prompt=await one("SELECT * FROM ai_prompt_versions WHERE feature=? AND status='Active' ORDER BY version DESC LIMIT 1",feature);
  const sourceGroups=feature==="deal-review"?Object.entries(data as Row).map(([type,value])=>({type,id:type==="deal"?entityId:`${entityId}:${type}`,value,excerpt:type==="deal"?clean((value as Row).name,220):`${type} evidence`})):Object.entries(data as Row).map(([type,value])=>({type,id:`current:${type}`,value,excerpt:`${type} evidence`}));
  const input=JSON.stringify({instruction:feature==="deal-review"?"Produce the weekly deal review. Use only this CRM evidence.":"Explain the current forecast. Use only this CRM evidence.",data}).slice(0,Number(settings.maxContextChars));
  const hashInput=JSON.stringify({input,promptVersion:Number(prompt?.version||1),model:settings.enabled?settings.model:`${feature}-rules-v1`}),inputHash=await sha256(hashInput);
  if(!force){const cached=await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature=? AND a.entity_type=? AND a.entity_id=? AND a.input_hash=? AND a.review_status!='Rejected' ORDER BY a.generated_at DESC LIMIT 1",feature,entityType,entityId,inputHash);if(cached)return {artifact:present(feature,cached),cached:true};}
  let output:ReturnType<typeof buildDealReview>|ReturnType<typeof buildForecastExplanation>,run:null|{id:string;startedAt:number}=null,provider="clientrecord",model=`${feature}-rules-v1`;
  if(Boolean(settings.enabled)&&providerConfigured()){
    const allowed=await assertAiRunAllowed(user);provider=String(allowed.provider);model=String(allowed.model);run=await beginAiRun({feature,entityType,entityId,requestedBy:user.email,provider,model,promptVersion:Number(prompt?.version||1),sourceCount:sourceGroups.length,input:hashInput});
    try{output=await modelResult(feature,input,allowed,prompt);await completeAiRun(run,JSON.stringify(output));}catch(error){await failAiRun(run,error);throw error;}
  }else output=feature==="deal-review"?buildDealReview(data as Awaited<ReturnType<typeof dealData>>):buildForecastExplanation(data as Awaited<ReturnType<typeof forecastData>>);
  const artifactId=crypto.randomUUID(),generatedAt=new Date().toISOString(),confidence=output.confidence==="High"?90:output.confidence==="Medium"?70:40,sources=await Promise.all(sourceGroups.map(async source=>({ ...source,hash:await sha256(JSON.stringify(source.value)) })));
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_artifacts SET superseded_by=? WHERE feature=? AND entity_type=? AND entity_id=? AND superseded_by IS NULL").bind(artifactId,feature,entityType,entityId),
    env.DB.prepare("INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,review_status,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,rules_version,input_hash,generated_by,generated_at) VALUES (?,?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?)").bind(artifactId,run?.id||null,feature,entityType,entityId,JSON.stringify(output),JSON.stringify(output),output.explanation,confidence,provider,model,Number(prompt?.version||1),`${feature}-v1`,inputHash,user.email,generatedAt),
    ...sources.map(source=>env.DB.prepare("INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,source_updated_at,content_hash,excerpt) VALUES (?,?,?,?,?,?)").bind(artifactId,source.type,source.id,null,source.hash,source.excerpt)),
  ]);
  return {artifact:present(feature,{id:artifactId,review_status:"Draft",content_json:JSON.stringify(output),explanation:output.explanation,confidence,provider,model,prompt_version:Number(prompt?.version||1),rules_version:`${feature}-v1`,generated_by:user.email,generated_at:generatedAt,source_count:sources.length}),cached:false};
}

export async function GET(request:Request){
  const user=await crmUser(request),error=denied(user,"ai.view");if(error||!user)return error;try{const dealRows=await rows("SELECT id,name,company,stage,owner,value,probability,forecast_category AS forecastCategory,close_date AS closeDate FROM deals WHERE status='Open' ORDER BY value DESC,name LIMIT 300"),[reviews,forecast]=await Promise.all([rows("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='deal-review' AND a.entity_type='deal' ORDER BY a.generated_at DESC LIMIT 80"),one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='forecast-explanation' AND a.entity_type='forecast' AND a.entity_id='current' AND a.review_status!='Rejected' ORDER BY a.generated_at DESC LIMIT 1")]),settings=await loadAiSettings();return Response.json({deals:dealRows,reviews:reviews.map(item=>present("deal-review",item)),forecast:forecast?present("forecast-explanation",forecast):null,settings:{enabled:Boolean(settings.enabled)},providerConfigured:providerConfigured(),permissions:{generate:can(user,"ai.generate"),review:can(user,"ai.review")}})}catch(error){return Response.json({error:error instanceof Error?error.message:"Revenue intelligence is unavailable."},{status:400})}
}
export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});try{const body=await request.json() as Row,action=clean(body.action,80);
    if(action==="generateDealReview"||action==="generateForecast"){
      const error=denied(user,"ai.generate");if(error)return error;const feature:Feature=action==="generateDealReview"?"deal-review":"forecast-explanation",result=await generate(feature,user,feature==="deal-review"?id(body.dealId):undefined,body.force===true);await audit(user,`ai.${feature}.generate`,`ai_artifact`,result.artifact.id,result.cached?"Used current AI analysis":"Generated AI analysis",{feature,dealId:body.dealId||null,cached:result.cached,sourceCount:result.artifact.sourceCount});return Response.json({ok:true,...result});
    }
    if(action==="review"){
      const error=denied(user,"ai.review");if(error)return error;const artifactId=clean(body.artifactId,120),record=await one("SELECT * FROM ai_artifacts WHERE id=? AND feature IN ('deal-review','forecast-explanation')",artifactId);if(!record)throw new Error("AI analysis was not found.");const status=clean(body.status,20);if(!["Accepted","Rejected"].includes(status))throw new Error("Choose accepted or rejected.");const before=JSON.stringify({reviewStatus:record.review_status,contentJson:record.content_json}),after=JSON.stringify({reviewStatus:status,contentJson:record.content_json});await env.DB.batch([env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").bind(artifactId,status,before,after,clean(body.comment,1000),user.email),env.DB.prepare("UPDATE ai_artifacts SET review_status=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").bind(status,user.email,artifactId)]);await audit(user,"ai.revenue.review","ai_artifact",artifactId,`${status} AI revenue analysis`,{status});return Response.json({ok:true});
    }
    throw new Error("Unknown AI revenue intelligence action.");
  }catch(error){return Response.json({error:error instanceof Error?error.message:"The AI analysis could not be completed."},{status:400})}
}
