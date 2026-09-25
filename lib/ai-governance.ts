import { env } from "cloudflare:workers";
import { can, sha256, type CRMUser } from "@/lib/crm-auth";

type Row = Record<string, unknown>;

export const aiFeatures = [
  { key:"relationship-health", name:"Relationship health", mode:"Deterministic", phase:2, description:"Explainable 0–100 account and deal health score." },
  { key:"stakeholder-coverage", name:"Stakeholder coverage", mode:"Deterministic", phase:3, description:"Coverage gaps across decision-maker, champion, buyer, and blocker roles." },
  { key:"next-best-action", name:"Next-best action", mode:"Rules", phase:4, description:"One prioritized action with a source-backed reason." },
  { key:"meeting-prep", name:"Meeting-preparation brief", mode:"Rules", phase:5, description:"Context, commitments, risks, stakeholder gaps, agenda, and questions." },
  { key:"follow-up-draft", name:"AI follow-up draft", mode:"Generative", phase:6, description:"Editable meeting summary, decisions, commitments, and email copy." },
  { key:"account-summary", name:"Account summary", mode:"Generative", phase:7, description:"Current account context from approved CRM records." },
  { key:"icp-tier", name:"ICP tier", mode:"Hybrid", phase:7, description:"Fit classification with evidence and confidence." },
  { key:"contact-persona", name:"Contact persona", mode:"Generative", phase:7, description:"Persona classification based on role and relationship context." },
  { key:"buying-stage", name:"Buying stage", mode:"Hybrid", phase:7, description:"Buying-stage classification separate from pipeline stage." },
  { key:"meddpicc", name:"MEDDPICC completeness", mode:"Hybrid", phase:7, description:"Qualification coverage with missing evidence." },
  { key:"deal-risk", name:"Deal-risk summary", mode:"Hybrid", phase:7, description:"Source-backed risk factors and mitigation summary." },
  { key:"proposal-draft", name:"AI proposal draft", mode:"Generative", phase:8, description:"Editable, source-backed commercial proposal for a deal." },
  { key:"deal-review", name:"AI deal-review copilot", mode:"Hybrid", phase:9, description:"Weekly deal movement, evidence, qualification gaps, close-date credibility, and actions." },
  { key:"forecast-explanation", name:"AI forecast explanation", mode:"Hybrid", phase:9, description:"Evidence-backed explanation of forecast movement, commit coverage, and close-date risk." },
  { key:"conversation-intelligence", name:"Conversation intelligence", mode:"Hybrid", phase:10, description:"Classifies linked email and meeting evidence for commitments, objections, competitors, pricing, and buying signals." },
  { key:"crm-hygiene", name:"CRM hygiene agent", mode:"Deterministic", phase:10, description:"Proposes duplicate, completeness, ownership, and date fixes for review." },
  { key:"account-plan", name:"Account-plan generator", mode:"Hybrid", phase:10, description:"Builds a living account brief from relationships, signals, documents, deals, risks, and objectives." },
  { key:"negotiation-intelligence", name:"Proposal and negotiation intelligence", mode:"Hybrid", phase:10, description:"Compares proposal history, concessions, commercial risks, and contract-related evidence." },
  { key:"crm-analysis", name:"Natural-language CRM analysis", mode:"Deterministic", phase:10, description:"Safely turns plain-language questions into live, evidence-backed CRM record lists." },
  { key:"recommendation-learning", name:"Recommendation learning loop", mode:"Deterministic", phase:10, description:"Shows accepted, dismissed, and completed recommendation outcomes without silently changing prioritization." },
] as const;

export const defaultAiSettings = {
  id:1, provider:"openai", model:"gpt-5-mini", enabled:false, dailyRunLimit:100, perUserDailyLimit:25,
  maxContextChars:60000, resultRetentionDays:730, requireReview:true, allowSensitiveSources:false, updatedBy:"", updatedAt:"",
};

export function providerConfigured(){ return Boolean(String(env.OPENAI_API_KEY||"").trim()); }

export async function loadAiSettings(){
  return await env.DB.prepare("SELECT id,provider,model,enabled,daily_run_limit AS dailyRunLimit,per_user_daily_limit AS perUserDailyLimit,max_context_chars AS maxContextChars,result_retention_days AS resultRetentionDays,require_review AS requireReview,allow_sensitive_sources AS allowSensitiveSources,updated_by AS updatedBy,updated_at AS updatedAt FROM ai_settings WHERE id=1").first<Row>() || defaultAiSettings;
}

export async function assertAiRunAllowed(user:CRMUser){
  const settings=await loadAiSettings();
  if(!settings.enabled)throw new Error("AI guidance is disabled.");
  if(!providerConfigured())throw new Error("The AI provider key is not configured.");
  const [total,personal]=await Promise.all([
    env.DB.prepare("SELECT count(*) AS count FROM ai_runs WHERE started_at>=date('now')").first<{count:number}>(),
    env.DB.prepare("SELECT count(*) AS count FROM ai_runs WHERE requested_by=? AND started_at>=date('now')").bind(user.email).first<{count:number}>(),
  ]);
  if(Number(total?.count||0)>=Number(settings.dailyRunLimit))throw new Error("The daily AI run limit has been reached.");
  if(Number(personal?.count||0)>=Number(settings.perUserDailyLimit))throw new Error("Your daily AI run limit has been reached.");
  return settings;
}

export async function beginAiRun(input:{feature:string;entityType:string;entityId?:unknown;requestedBy:string;provider:string;model:string;promptVersion?:number|null;sourceCount:number;input:string}){
  const id=crypto.randomUUID(),inputHash=await sha256(input.input);
  await env.DB.prepare("INSERT INTO ai_runs(id,feature,entity_type,entity_id,status,provider,model,prompt_version,input_hash,requested_by,source_count,input_chars,started_at) VALUES (?,?,?,?,'Running',?,?,?,?,?,?,?,datetime('now'))")
    .bind(id,input.feature,input.entityType,input.entityId==null?null:String(input.entityId),input.provider,input.model,input.promptVersion??null,inputHash,input.requestedBy,input.sourceCount,input.input.length).run();
  return {id,inputHash,startedAt:Date.now()};
}

export async function completeAiRun(run:{id:string;startedAt:number},output:string){
  await env.DB.prepare("UPDATE ai_runs SET status='Completed',output_chars=?,latency_ms=?,estimated_tokens=?,completed_at=datetime('now') WHERE id=?")
    .bind(output.length,Date.now()-run.startedAt,Math.ceil(output.length/4),run.id).run();
}

export async function failAiRun(run:{id:string;startedAt:number},error:unknown){
  const message=(error instanceof Error?error.message:String(error)).slice(0,2000);
  await env.DB.prepare("UPDATE ai_runs SET status='Failed',error=?,latency_ms=?,completed_at=datetime('now') WHERE id=?").bind(message,Date.now()-run.startedAt,run.id).run();
}

export async function findCachedArtifact(feature:string,entityType:string,entityId:unknown,inputHash:string,currentOnly=false,sensitive=false){
  return env.DB.prepare(`SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature=? AND a.entity_type=? AND a.entity_id IS ? AND a.input_hash=? AND a.sensitive=? AND a.review_status!='Rejected'${currentOnly?" AND a.superseded_by IS NULL":""} ORDER BY a.generated_at DESC LIMIT 1`)
    .bind(feature,entityType,entityId==null?null:String(entityId),inputHash,sensitive?1:0).first<Row>();
}

// AI artifacts built from sensitive client documents (ai_artifacts.sensitive) are visible only with documents.manage_sensitive.
// Every reader of ai_artifacts adds this condition, so hidden artifacts can be neither listed nor reviewed/edited.
export const canSeeSensitive=(user:CRMUser)=>can(user,"documents.manage_sensitive");
export const visibleArtifactSql=(user:CRMUser,alias="a")=>canSeeSensitive(user)?"1=1":`${alias?`${alias}.`:""}sensitive=0`;
