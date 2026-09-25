import { env } from "cloudflare:workers";
import { loadAiSettings, providerConfigured, visibleArtifactSql } from "@/lib/ai-governance";
import { runAiArtifact } from "@/lib/ai-runner";
import { buildDealReview, buildForecastExplanation, dealReviewSchema, forecastNarrativeSchema, forecastTotals, normalizeDealReview, normalizeForecastExplanation, type DealReview, type ForecastExplanation } from "@/lib/ai-revenue-intelligence";
import { audit, can, crmUser, type CRMUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
type Feature="deal-review"|"forecast-explanation";
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();
const parse=(value:unknown,fallback:unknown={})=>{try{return JSON.parse(String(value??""))}catch{return fallback}};
const id=(value:unknown)=>{const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error("Choose a valid deal.");return number};
const denied=(user:CRMUser|null,permission:"ai.view"|"ai.generate"|"ai.review")=>!user?Response.json({error:"Sign in is required."},{status:401}):!can(user,permission)?Response.json({error:`${permission} permission is required.`},{status:403}):null;

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
async function generate(feature:Feature,user:CRMUser,dealId?:number,force=false){
  const isDeal=feature==="deal-review",data=isDeal?await dealData(dealId!):await forecastData(),entityType=isDeal?"deal":"forecast",entityId=isDeal?String(dealId):"current",totals=isDeal?null:forecastTotals((data as Awaited<ReturnType<typeof forecastData>>).deals);
  const sourceGroups=isDeal?Object.entries(data as Row).map(([type,value])=>({type,id:type==="deal"?entityId:`${entityId}:${type}`,value,excerpt:type==="deal"?clean((value as Row).name,220):`${type} evidence`})):Object.entries(data as Row).map(([type,value])=>({type,id:`current:${type}`,value,excerpt:`${type} evidence`}));
  const model=isDeal?{schema:dealReviewSchema,schemaName:"clientrecord_deal_review",normalize:normalizeDealReview,system:"Create a concise weekly deal review using only supplied ClientRecord CRM records. Do not invent events, customer intent, dates, commitments, or forecast outcomes. Distinguish facts from missing data and make actions specific."}:{schema:forecastNarrativeSchema,schemaName:"clientrecord_forecast_explanation",normalize:normalizeForecastExplanation,system:"Explain the CRM forecast using only supplied ClientRecord records. The forecast totals are computed by ClientRecord and supplied as facts; do not restate different figures. Do not invent historical performance or predict revenue. Identify evidence, uncertainty, and concrete actions."};
  const result=await runAiArtifact<DealReview|ForecastExplanation>({feature,entityType,entityId,user,force,instruction:isDeal?"Produce the weekly deal review. Use only this CRM evidence.":"Explain the current forecast. Use only this CRM evidence.",data:totals?{data,computedTotals:totals}:{data},rulesModel:`${feature}-rules-v1`,rulesVersion:`${feature}-v1`,sources:sourceGroups.map(source=>({type:source.type,id:source.id,excerpt:source.excerpt,content:JSON.stringify(source.value)})),model:{...model,maxOutputTokens:2600},rules:()=>isDeal?buildDealReview(data as Awaited<ReturnType<typeof dealData>>):buildForecastExplanation(data as Awaited<ReturnType<typeof forecastData>>),finalize:output=>totals?{...output,...totals}:output});
  return {artifact:present(feature,result.row),cached:result.cached};
}

export async function GET(request:Request){
  const user=await crmUser(request),error=denied(user,"ai.view");if(error||!user)return error;try{const dealRows=await rows("SELECT id,name,company,stage,owner,value,probability,forecast_category AS forecastCategory,close_date AS closeDate FROM deals WHERE status='Open' ORDER BY value DESC,name LIMIT 300"),[reviews,forecast]=await Promise.all([rows(`SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='deal-review' AND a.entity_type='deal' AND ${visibleArtifactSql(user)} ORDER BY a.generated_at DESC LIMIT 80`),one(`SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='forecast-explanation' AND a.entity_type='forecast' AND a.entity_id='current' AND a.review_status!='Rejected' AND ${visibleArtifactSql(user)} ORDER BY a.generated_at DESC LIMIT 1`)]),settings=await loadAiSettings();return Response.json({deals:dealRows,reviews:reviews.map(item=>present("deal-review",item)),forecast:forecast?present("forecast-explanation",forecast):null,settings:{enabled:Boolean(settings.enabled)},providerConfigured:providerConfigured(),permissions:{generate:can(user,"ai.generate"),review:can(user,"ai.review")}})}catch(error){return Response.json({error:error instanceof Error?error.message:"Revenue intelligence is unavailable."},{status:400})}
}
export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});try{const body=await request.json() as Row,action=clean(body.action,80);
    if(action==="generateDealReview"||action==="generateForecast"){
      const error=denied(user,"ai.generate");if(error)return error;const feature:Feature=action==="generateDealReview"?"deal-review":"forecast-explanation",result=await generate(feature,user,feature==="deal-review"?id(body.dealId):undefined,body.force===true);await audit(user,`ai.${feature}.generate`,`ai_artifact`,result.artifact.id,result.cached?"Used current AI analysis":"Generated AI analysis",{feature,dealId:body.dealId||null,cached:result.cached,sourceCount:result.artifact.sourceCount});return Response.json({ok:true,...result});
    }
    if(action==="review"){
      const error=denied(user,"ai.review");if(error)return error;const artifactId=clean(body.artifactId,120),record=await one(`SELECT * FROM ai_artifacts WHERE id=? AND feature IN ('deal-review','forecast-explanation') AND ${visibleArtifactSql(user,"")}`,artifactId);if(!record)throw new Error("AI analysis was not found.");const status=clean(body.status,20);if(!["Accepted","Rejected"].includes(status))throw new Error("Choose accepted or rejected.");const before=JSON.stringify({reviewStatus:record.review_status,contentJson:record.content_json}),after=JSON.stringify({reviewStatus:status,contentJson:record.content_json});await env.DB.batch([env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").bind(artifactId,status,before,after,clean(body.comment,1000),user.email),env.DB.prepare("UPDATE ai_artifacts SET review_status=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").bind(status,user.email,artifactId)]);await audit(user,"ai.revenue.review","ai_artifact",artifactId,`${status} AI revenue analysis`,{status});return Response.json({ok:true});
    }
    throw new Error("Unknown AI revenue intelligence action.");
  }catch(error){return Response.json({error:error instanceof Error?error.message:"The AI analysis could not be completed."},{status:400})}
}
