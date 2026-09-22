import { env } from "cloudflare:workers";
import { aiFeatures, loadAiSettings, providerConfigured } from "@/lib/ai-governance";
import { audit, can, crmUser, type CRMUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
const bool=(value:unknown)=>value===true||value===1||value==="1"||value==="true"||value==="on";
const int=(value:unknown,min:number,max:number,fallback:number)=>{const parsed=Number(value);return Number.isFinite(parsed)?Math.min(max,Math.max(min,Math.round(parsed))):fallback};
const allowedFeatures=new Set<string>(aiFeatures.map(feature=>feature.key));

function denied(user:CRMUser|null,permission:"ai.view"|"ai.configure"|"ai.review"){
  if(!user)return Response.json({error:"Authorized sign-in is required."},{status:401});
  if(!can(user,permission))return Response.json({error:`${permission} permission is required.`},{status:403});
  return null;
}

export async function GET(request:Request){
  const user=await crmUser(request),error=denied(user,"ai.view");if(error||!user)return error;
  const configure=can(user,"ai.configure"),review=can(user,"ai.review"),settings=await loadAiSettings();
  const [usage,prompts,runs,artifacts]=await Promise.all([
    env.DB.prepare("SELECT count(*) AS total,sum(CASE WHEN status='Failed' THEN 1 ELSE 0 END) AS failed,sum(CASE WHEN started_at>=date('now') THEN 1 ELSE 0 END) AS today,sum(CASE WHEN started_at>=datetime('now','-30 days') THEN 1 ELSE 0 END) AS month FROM ai_runs").first<Row>(),
    configure?env.DB.prepare("SELECT id,feature,version,name,response_schema AS responseSchema,status,created_by AS createdBy,created_at AS createdAt,activated_by AS activatedBy,activated_at AS activatedAt FROM ai_prompt_versions ORDER BY feature,version DESC").all<Row>():Promise.resolve({results:[] as Row[]}),
    env.DB.prepare("SELECT id,feature,entity_type AS entityType,entity_id AS entityId,status,provider,model,prompt_version AS promptVersion,requested_by AS requestedBy,source_count AS sourceCount,latency_ms AS latencyMs,estimated_tokens AS estimatedTokens,error,started_at AS startedAt,completed_at AS completedAt FROM ai_runs ORDER BY started_at DESC LIMIT 50").all<Row>(),
    env.DB.prepare(`SELECT a.id,a.feature,a.entity_type AS entityType,a.entity_id AS entityId,a.review_status AS reviewStatus,a.content_json AS contentJson,a.explanation,a.confidence,a.provider,a.model,a.prompt_version AS promptVersion,a.rules_version AS rulesVersion,a.generated_by AS generatedBy,a.generated_at AS generatedAt,a.reviewed_by AS reviewedBy,a.reviewed_at AS reviewedAt,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS sourceCount FROM ai_artifacts a ${review?"":"WHERE a.review_status='Accepted'"} ORDER BY a.generated_at DESC LIMIT 50`).all<Row>(),
  ]);
  const pending=await env.DB.prepare("SELECT count(*) AS count FROM ai_artifacts WHERE review_status='Draft'").first<{count:number}>();
  return Response.json({account:{email:user.email,role:user.role},permissions:{view:true,generate:can(user,"ai.generate"),review,configure},providerConfigured:providerConfigured(),settings,features:aiFeatures,prompts:prompts.results,runs:runs.results,artifacts:artifacts.results,usage:{total:Number(usage?.total||0),today:Number(usage?.today||0),month:Number(usage?.month||0),failed:Number(usage?.failed||0),pendingReview:Number(pending?.count||0)}});
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Authorized sign-in is required."},{status:401});
  const body=await request.json().catch(()=>({})) as Row,action=String(body.action||"");
  if(action==="saveSettings"){
    const error=denied(user,"ai.configure");if(error)return error;
    const enabled=bool(body.enabled);if(enabled&&!providerConfigured())return Response.json({error:"Add OPENAI_API_KEY as a secure Site secret before enabling AI guidance."},{status:400});
    const provider=String(body.provider||"openai").trim().toLowerCase(),model=String(body.model||"").trim();
    if(provider!=="openai")return Response.json({error:"OpenAI is the supported provider for this release."},{status:400});
    if(!model||model.length>120)return Response.json({error:"Enter a valid model identifier."},{status:400});
    const current=await loadAiSettings(),next={provider,model,enabled,dailyRunLimit:int(body.dailyRunLimit,1,10000,Number(current.dailyRunLimit)),perUserDailyLimit:int(body.perUserDailyLimit,1,1000,Number(current.perUserDailyLimit)),maxContextChars:int(body.maxContextChars,1000,500000,Number(current.maxContextChars)),resultRetentionDays:int(body.resultRetentionDays,30,3650,Number(current.resultRetentionDays)),requireReview:bool(body.requireReview),allowSensitiveSources:bool(body.allowSensitiveSources)};
    await env.DB.prepare("INSERT INTO ai_settings(id,provider,model,enabled,daily_run_limit,per_user_daily_limit,max_context_chars,result_retention_days,require_review,allow_sensitive_sources,updated_by,updated_at) VALUES (1,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,enabled=excluded.enabled,daily_run_limit=excluded.daily_run_limit,per_user_daily_limit=excluded.per_user_daily_limit,max_context_chars=excluded.max_context_chars,result_retention_days=excluded.result_retention_days,require_review=excluded.require_review,allow_sensitive_sources=excluded.allow_sensitive_sources,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .bind(next.provider,next.model,next.enabled?1:0,next.dailyRunLimit,next.perUserDailyLimit,next.maxContextChars,next.resultRetentionDays,next.requireReview?1:0,next.allowSensitiveSources?1:0,user.email).run();
    await audit(user,"ai.settings.update","ai_settings",1,"Updated AI governance settings",{before:current,after:next});
    return Response.json({ok:true,settings:await loadAiSettings()});
  }
  if(action==="createPromptVersion"){
    const error=denied(user,"ai.configure");if(error)return error;
    const feature=String(body.feature||""),name=String(body.name||"").trim(),systemPrompt=String(body.systemPrompt||"").trim(),responseSchema=String(body.responseSchema||"{}").trim();
    if(!allowedFeatures.has(feature))return Response.json({error:"Choose a supported AI feature."},{status:400});
    if(!name||name.length>120||systemPrompt.length<20||systemPrompt.length>30000)return Response.json({error:"Enter a name and a prompt between 20 and 30,000 characters."},{status:400});
    try{JSON.parse(responseSchema)}catch{return Response.json({error:"Response schema must be valid JSON."},{status:400})}
    const latest=await env.DB.prepare("SELECT max(version) AS version FROM ai_prompt_versions WHERE feature=?").bind(feature).first<{version:number|null}>(),version=Number(latest?.version||0)+1,id=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO ai_prompt_versions(id,feature,version,name,system_prompt,response_schema,status,created_by,created_at) VALUES (?,?,?,?,?,?,'Draft',?,datetime('now'))").bind(id,feature,version,name,systemPrompt,responseSchema,user.email).run();
    await audit(user,"ai.prompt.create","ai_prompt_version",id,`Created ${feature} prompt version ${version}`,{feature,version,name,responseSchema});
    return Response.json({ok:true,id,version},{status:201});
  }
  if(action==="activatePromptVersion"){
    const error=denied(user,"ai.configure");if(error)return error;const id=String(body.id||"");
    const prompt=await env.DB.prepare("SELECT id,feature,version,status FROM ai_prompt_versions WHERE id=?").bind(id).first<Row>();if(!prompt)return Response.json({error:"Prompt version was not found."},{status:404});
    await env.DB.batch([
      env.DB.prepare("UPDATE ai_prompt_versions SET status='Archived' WHERE feature=? AND status='Active'").bind(prompt.feature),
      env.DB.prepare("UPDATE ai_prompt_versions SET status='Active',activated_by=?,activated_at=datetime('now') WHERE id=?").bind(user.email,id),
    ]);
    await audit(user,"ai.prompt.activate","ai_prompt_version",id,`Activated ${prompt.feature} prompt version ${prompt.version}`,prompt);
    return Response.json({ok:true});
  }
  if(action==="reviewArtifact"){
    const error=denied(user,"ai.review");if(error)return error;const id=String(body.id||""),status=String(body.status||"");
    if(!["Accepted","Edited","Rejected"].includes(status))return Response.json({error:"Choose Accepted, Edited, or Rejected."},{status:400});
    const artifact=await env.DB.prepare("SELECT id,review_status AS reviewStatus,content_json AS contentJson FROM ai_artifacts WHERE id=?").bind(id).first<Row>();if(!artifact)return Response.json({error:"AI result was not found."},{status:404});
    let contentJson=String(artifact.contentJson||"{}");if(status==="Edited"){try{contentJson=JSON.stringify(JSON.parse(String(body.contentJson||"{}")))}catch{return Response.json({error:"Edited content must be valid JSON."},{status:400})}}
    const before=JSON.stringify({reviewStatus:artifact.reviewStatus,contentJson:artifact.contentJson}),after=JSON.stringify({reviewStatus:status,contentJson});
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").bind(id,status,before,after,String(body.comment||"").slice(0,4000),user.email),
      env.DB.prepare("UPDATE ai_artifacts SET review_status=?,content_json=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").bind(status,contentJson,user.email,id),
    ]);
    await audit(user,"ai.artifact.review","ai_artifact",id,`${status} AI result`,{before:JSON.parse(before),after:JSON.parse(after),comment:String(body.comment||"")});
    return Response.json({ok:true});
  }
  return Response.json({error:"Unknown AI governance action."},{status:400});
}
