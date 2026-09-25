import { env } from "cloudflare:workers";
import { assertAiRunAllowed, beginAiRun, completeAiRun, failAiRun, findCachedArtifact, loadAiSettings, providerConfigured } from "@/lib/ai-governance";
import { sha256, type CRMUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
export type AiSource={type:string;id:string;updatedAt?:string|null;excerpt:string;content:string};
export type AiModelSpec<T>={system:string;schema:unknown;schemaName:string;maxOutputTokens:number;normalize:(value:unknown)=>T;emptyMessage?:string};
export type AiRunOptions<T extends {explanation:string;confidence:string}>={feature:string;promptFeature?:string;entityType:string;entityId:string;user:CRMUser;force:boolean;instruction:string;data:Row;rulesModel:string;rulesVersion:string;sources:AiSource[];model:AiModelSpec<T>;rules:()=>T;finalize?:(output:T,modelBacked:boolean)=>T;currentOnly?:boolean};

const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const confidenceScore=(value:string)=>value==="High"?90:value==="Medium"?70:40;
export const aiMode=(provider:unknown)=>String(provider)==="openai"?"Model-backed":"Rules-based";

export function outputText(response:Row){
  if(typeof response.output_text==="string")return response.output_text;
  return (Array.isArray(response.output)?response.output:[]).flatMap(item=>{const row=item as Row;return Array.isArray(row.content)?row.content as Row[]:[]}).map(item=>item.type==="output_text"?clean(item.text,50000):"").join("");
}

// Shrinks a JSON-serializable value until it fits maxChars: long strings are cut first, then array tails. Always returns valid JSON.
export function fitJson(value:Row,maxChars:number){
  const full=JSON.stringify(value);if(full.length<=maxChars)return {json:full,truncated:false};
  const shrink=(item:unknown,strMax:number,arrMax:number):unknown=>typeof item==="string"?(item.length>strMax?`${item.slice(0,strMax)}…`:item):Array.isArray(item)?item.slice(0,arrMax).map(entry=>shrink(entry,strMax,arrMax)):item&&typeof item==="object"?Object.fromEntries(Object.entries(item as Row).map(([key,entry])=>[key,shrink(entry,strMax,arrMax)])):item;
  for(const [strMax,arrMax] of [[4000,500],[2000,500],[1000,500],[500,500],[250,500],[120,500],[120,100],[120,40],[120,15],[80,5],[60,2],[40,1],[40,0]]){const json=JSON.stringify({...shrink(value,strMax,arrMax) as Row,contextTruncated:true});if(json.length<=maxChars)return {json,truncated:true};}
  const minimal=JSON.stringify({instruction:clean(value.instruction,Math.max(0,maxChars-60)),contextTruncated:true});
  return {json:minimal.length<=maxChars?minimal:'{"contextTruncated":true}',truncated:true};
}

export async function callModel<T>(spec:AiModelSpec<T>,settings:Row,prompt:Row|null,input:string){
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{authorization:`Bearer ${clean(env.OPENAI_API_KEY,1000)}`,"content-type":"application/json"},body:JSON.stringify({model:String(settings.model),input:[{role:"system",content:clean(prompt?.system_prompt,30000)||spec.system},{role:"user",content:input}],max_output_tokens:spec.maxOutputTokens,text:{format:{type:"json_schema",name:spec.schemaName,strict:true,schema:spec.schema}}})});
  const payload=await response.json() as Row;if(!response.ok)throw new Error(clean((payload.error as Row|undefined)?.message,1200)||`AI provider returned ${response.status}.`);const text=outputText(payload);if(!text)throw new Error(spec.emptyMessage||"The AI provider returned no result.");return spec.normalize(JSON.parse(text));
}

export const artifactById=(id:string)=>env.DB.prepare("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.id=?").bind(id).first<Row>();

// Shared governed pipeline: context → hash → artifact cache → run limits → model or rules → artifact + sources + supersede.
export async function runAiArtifact<T extends {explanation:string;confidence:string}>(options:AiRunOptions<T>){
  const settings=await loadAiSettings(),prompt=await env.DB.prepare("SELECT * FROM ai_prompt_versions WHERE feature=? AND status='Active' ORDER BY version DESC LIMIT 1").bind(options.promptFeature||options.feature).first<Row>(),promptVersion=Number(prompt?.version||1),modelBacked=Boolean(settings.enabled)&&providerConfigured();
  const {json:input}=fitJson({instruction:options.instruction,...options.data},Number(settings.maxContextChars||60000)),hashInput=JSON.stringify({input,promptVersion,model:modelBacked?settings.model:options.rulesModel}),inputHash=await sha256(hashInput);
  if(!options.force){const cached=await findCachedArtifact(options.feature,options.entityType,options.entityId,inputHash,options.currentOnly);if(cached)return {row:cached,cached:true};}
  let output:T,run:null|{id:string;startedAt:number}=null,provider="clientrecord",model=options.rulesModel;
  if(modelBacked){
    const allowed=await assertAiRunAllowed(options.user);provider=String(allowed.provider);model=String(allowed.model);run=await beginAiRun({feature:options.feature,entityType:options.entityType,entityId:options.entityId,requestedBy:options.user.email,provider,model,promptVersion,sourceCount:options.sources.length,input:hashInput});
    try{output=await callModel(options.model,allowed,prompt,input);if(options.finalize)output=options.finalize(output,true);await completeAiRun(run,JSON.stringify(output));}catch(error){await failAiRun(run,error);throw error;}
  }else{output=options.rules();if(options.finalize)output=options.finalize(output,false);}
  const artifactId=crypto.randomUUID(),generatedAt=new Date().toISOString(),sources=await Promise.all(options.sources.map(async source=>({...source,hash:await sha256(source.content)})));
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_artifacts SET superseded_by=? WHERE feature=? AND entity_type=? AND entity_id=? AND superseded_by IS NULL").bind(artifactId,options.feature,options.entityType,options.entityId),
    env.DB.prepare("INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,review_status,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,rules_version,input_hash,generated_by,generated_at) VALUES (?,?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?)").bind(artifactId,run?.id||null,options.feature,options.entityType,options.entityId,JSON.stringify(output),JSON.stringify(output),output.explanation,confidenceScore(output.confidence),provider,model,promptVersion,options.rulesVersion,inputHash,options.user.email,generatedAt),
    ...sources.map(source=>env.DB.prepare("INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,source_updated_at,content_hash,excerpt) VALUES (?,?,?,?,?,?)").bind(artifactId,source.type,source.id.slice(0,1000),source.updatedAt||null,source.hash,source.excerpt.slice(0,1000))),
  ]);
  return {row:(await artifactById(artifactId))!,cached:false,provider,model,promptVersion};
}
