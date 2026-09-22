import { env } from "cloudflare:workers";
import { audit, can, canAdmin, crmUser, sha256 } from "@/lib/crm-auth";
import { calculateRelationshipHealth } from "@/lib/relationship-health";
import { defaultPipeline, type Stage } from "@/lib/sales-rules";
import { calculateStakeholderCoverage, dealStakeholderRoles } from "@/lib/stakeholder-coverage";
import { generateRecommendationCandidates, type RecommendationCandidate } from "@/lib/next-best-action";
import { buildMeetingPreparationBrief } from "@/lib/meeting-intelligence";

type Row=Record<string,unknown>;
const text=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const id=(value:unknown)=>{const n=Number(value);if(!Number.isInteger(n)||n<1)throw new Error("A valid record is required.");return n};
const money=(value:unknown)=>{const n=Number(value);if(!Number.isFinite(n)||n<0||n>1e10)throw new Error("Enter a valid amount.");return Math.round(n*100)};
const bool=(value:unknown)=>value===true||value===1||value==="1"||value==="true"||value==="on";
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();
const stringList=(value:unknown)=>Array.isArray(value)?value.map(item=>text(item,2000)).filter(Boolean):text(value,12000).split(/\r?\n/).map(item=>item.replace(/^[-*]\s*/,"").trim()).filter(Boolean).slice(0,50);
const json=(value:unknown,fallback:unknown=[]):unknown=>{try{return JSON.parse(String(value??""))}catch{return fallback}};

async function dealRecord(dealId:number){
  const deal=await one("SELECT d.*,COALESCE(d.company_id,c.id) AS resolved_company_id FROM deals d LEFT JOIN companies c ON c.name=d.company WHERE d.id=?",dealId);
  if(!deal)throw new Error("Deal not found.");
  return deal;
}

async function ensureMeetingRecords(dealId:number){
  const activities=await rows("SELECT * FROM deal_activities WHERE deal_id=? AND lower(type) LIKE '%meeting%' ORDER BY happened_at",dealId);
  for(const activity of activities){
    const meetingId=`activity-${activity.id}`,outcome=text(activity.outcome,60),status=/cancel/i.test(outcome)?"Cancelled":/complet|held|attended|met/i.test(outcome)||Date.parse(String(activity.happened_at))<Date.now()?"Completed":"Scheduled";
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO deal_meetings(id,deal_id,company_id,activity_id,subject,status,starts_at,owner,summary,source_provider,external_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(meetingId,dealId,activity.company_id?Number(activity.company_id):null,Number(activity.id),text(activity.subject,240)||"Customer meeting",status,String(activity.happened_at),text(activity.owner,200)||"Unassigned",text(activity.body),text(activity.source,40)||"Manual",text(activity.external_id,240)||null,text(activity.owner,200)||"System",String(activity.created_at||activity.happened_at),String(activity.updated_at||activity.happened_at)),
      ...(activity.contact_id?[env.DB.prepare("INSERT INTO deal_meeting_attendees(meeting_id,contact_id,name,email,role,created_at) SELECT ?,c.id,c.first_name||' '||c.last_name,c.email,'Attendee',? FROM contacts c WHERE c.id=? AND NOT EXISTS(SELECT 1 FROM deal_meeting_attendees a WHERE a.meeting_id=? AND a.contact_id=c.id)").bind(meetingId,String(activity.created_at||activity.happened_at),Number(activity.contact_id),meetingId)]:[]),
    ]);
  }
}

function meetingArtifact(row:Row|null){
  if(!row)return null;const content=json(row.content_json,{}) as Row;
  return {id:row.id,meetingKey:String(row.entity_id||"").split(":").slice(1).join(":"),reviewStatus:row.review_status,content,explanation:row.explanation,confidence:Number(row.confidence||0),provider:row.provider,model:row.model,promptVersion:row.prompt_version,rulesVersion:row.rules_version,inputHash:row.input_hash,generatedBy:row.generated_by,generatedAt:row.generated_at,reviewedBy:row.reviewed_by,reviewedAt:row.reviewed_at,sourceCount:Number(row.source_count||0)};
}

async function coverageStage(deal:Row){
  const saved=await one("SELECT stages FROM sales_pipelines WHERE id=?",String(deal.pipeline_key||"default"));
  let stages:Stage[]=String(deal.pipeline_key||"default")==="default"?defaultPipeline.stages:[];
  if(saved?.stages)try{const parsed=JSON.parse(String(saved.stages));if(Array.isArray(parsed))stages=parsed}catch{}
  const current=stages.find(stage=>stage.key===String(deal.stage_key)||stage.name===String(deal.stage));
  const kind=(current?.kind||(["Won","Lost"].includes(String(deal.status))?String(deal.status):"Open")) as "Open"|"Won"|"Lost",open=stages.filter(stage=>stage.kind==="Open"),index=kind==="Open"?Math.max(0,open.findIndex(stage=>stage===current)):Math.max(0,open.length-1);
  return {key:current?.key||String(deal.stage_key||deal.stage),name:current?.name||String(deal.stage),index,openStageCount:Math.max(1,open.length),probability:Number(current?.probability??deal.probability??0),kind};
}

function calculateHealth(deal:Row,tasks:Row[],activities:Row[],stakeholders:Row[],insights:Row[],reviews:Row[],lineItems:Row[]){
  let score=100;const reasons:string[]=[];const today=new Date().toISOString().slice(0,10);
  const subtract=(points:number,reason:string)=>{score-=points;reasons.push(reason)};
  if(String(deal.status)==="Open"&&!text(deal.next_step))subtract(20,"No next action");
  if(String(deal.status)==="Open"&&!deal.close_date)subtract(10,"No expected close date");
  if(tasks.some(task=>!task.completed&&String(task.due_date)<today))subtract(15,"Overdue deal task");
  const recent=activities.some(activity=>Date.parse(String(activity.happened_at))>=Date.now()-14*86400000);
  if(String(deal.status)==="Open"&&!recent)subtract(15,"No activity in 14 days");
  if(!stakeholders.some(item=>item.active===undefined||Boolean(item.active)))subtract(10,"No active deal stakeholders");
  if(insights.some(item=>item.kind==="Risk"&&item.status!=="Resolved"&&item.severity==="High"))subtract(15,"Unresolved high risk");
  if(["Proposal","Negotiation"].includes(String(deal.stage))&&!lineItems.length)subtract(10,"No products or line items");
  if(reviews.some(review=>review.status==="Rejected"))subtract(10,"Approval rejected");
  return {score:Math.max(0,score),status:score>=80?"Healthy":score>=55?"Watch":"At risk",reasons};
}

async function relationshipHealth(dealId:number,deal:Row,tasks:Row[],activities:Row[],stakeholders:Row[]){
  const calculation=calculateRelationshipHealth({deal,tasks,activities,stakeholders});
  const inputHash=await sha256(JSON.stringify({calculationDate:new Date().toISOString().slice(0,10),deal:{createdAt:deal.created_at,updatedAt:deal.updated_at,status:deal.status,nextStep:deal.next_step},activities:activities.map(item=>({id:item.id,type:item.type,outcome:item.outcome,happenedAt:item.happened_at,followUpAt:item.follow_up_at,contactId:item.contact_id,threadKey:item.thread_key,responseExpected:item.response_expected,updatedAt:item.updated_at})),tasks:tasks.map(item=>({id:item.id,dueDate:item.due_date,completed:item.completed})),stakeholders:stakeholders.map(item=>({id:item.id,contactId:item.contact_id,role:item.role,updatedAt:item.updated_at}))}));
  await env.DB.prepare("INSERT OR IGNORE INTO deal_relationship_health_scores(deal_id,score,band,provisional,confidence,confidence_score,components_json,evidence_json,data_gaps_json,input_hash,calculated_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))")
    .bind(dealId,calculation.score,calculation.band,calculation.provisional?1:0,calculation.confidence,calculation.confidenceScore,JSON.stringify(calculation.components),JSON.stringify(calculation.evidence),JSON.stringify(calculation.dataGaps),inputHash).run();
  const history=await rows("SELECT id,score,band,provisional,confidence,confidence_score AS confidenceScore,components_json AS componentsJson,evidence_json AS evidenceJson,data_gaps_json AS dataGapsJson,input_hash AS inputHash,calculated_at AS calculatedAt FROM deal_relationship_health_scores WHERE deal_id=? ORDER BY calculated_at DESC,id DESC LIMIT 8",dealId),current=history[0],previous=history[1];
  const parse=(value:unknown,fallback:unknown[])=>{try{const parsed=JSON.parse(String(value||"[]"));return Array.isArray(parsed)?parsed:fallback}catch{return fallback}};
  const delta=previous?Number(current.score)-Number(previous.score):null,direction=delta==null?"New":delta>0?"Up":delta<0?"Down":"No change";
  return {score:Number(current.score),band:String(current.band),provisional:Boolean(current.provisional),confidence:String(current.confidence),confidenceScore:Number(current.confidenceScore),components:parse(current.componentsJson,calculation.components),evidence:parse(current.evidenceJson,calculation.evidence),dataGaps:parse(current.dataGapsJson,calculation.dataGaps),calculatedAt:String(current.calculatedAt),previousScore:previous?Number(previous.score):null,direction,change:delta,meaningfulInteractions:calculation.meaningfulInteractions,history:history.map(item=>({id:item.id,score:Number(item.score),band:item.band,provisional:Boolean(item.provisional),confidence:item.confidence,calculatedAt:item.calculatedAt}))};
}

const recommendationSelect=`SELECT r.*,t.title AS task_title,t.completed AS task_completed FROM deal_recommendations r LEFT JOIN deal_tasks t ON t.id=r.task_id`;
const recommendationJson=(row:Row|null)=>{if(!row)return null;let evidence:string[]=[];try{const parsed=JSON.parse(String(row.evidence_json||"[]"));if(Array.isArray(parsed))evidence=parsed.map(String)}catch{}return {id:row.id,ruleKey:row.rule_key,fingerprint:row.fingerprint,action:row.action,reason:row.reason,evidence,priority:row.priority,suggestedOwner:row.suggested_owner,suggestedDueDate:row.suggested_due_date,status:row.status,taskId:row.task_id,taskTitle:row.task_title,taskCompleted:Boolean(row.task_completed),generatedAt:row.generated_at,acceptedAt:row.accepted_at,dismissedAt:row.dismissed_at,completedAt:row.completed_at,decidedBy:row.decided_by,decisionNote:row.decision_note,updatedAt:row.updated_at}};
async function nextBestAction(dealId:number,deal:Row,tasks:Row[],reviews:Row[],proposals:Row[],insights:Row[],activities:Row[],coverage:ReturnType<typeof calculateStakeholderCoverage>){
  const now=new Date(),stamp=now.toISOString();let current=await one(`${recommendationSelect} WHERE r.deal_id=? AND r.current_key='current' LIMIT 1`,dealId);
  if(current?.task_id&&current.task_completed){await env.DB.prepare("UPDATE deal_recommendations SET status='Completed',current_key=NULL,completed_at=?,updated_at=? WHERE id=?").bind(stamp,stamp,String(current.id)).run();current=null}
  if(current&&String(deal.status)!=="Open"){await env.DB.prepare("UPDATE deal_recommendations SET status='Superseded',current_key=NULL,updated_at=? WHERE id=?").bind(stamp,String(current.id)).run();current=null}
  const candidates=generateRecommendationCandidates({deal,tasks,reviews,proposals,insights,activities,coverage,now});
  if(current&&String(current.status)==="Active"&&!candidates.some(candidate=>candidate.fingerprint===String(current!.fingerprint))){await env.DB.prepare("UPDATE deal_recommendations SET status='Superseded',current_key=NULL,updated_at=? WHERE id=?").bind(stamp,String(current.id)).run();current=null}
  if(!current&&String(deal.status)==="Open"){
    const prior=await rows("SELECT fingerprint,status FROM deal_recommendations WHERE deal_id=?",dealId),suppressed=new Set(prior.filter(item=>["Dismissed","Completed"].includes(String(item.status))).map(item=>String(item.fingerprint)));
    let candidate=candidates.find(item=>!suppressed.has(item.fingerprint));
    if(!candidate){candidate={ruleKey:"review-plan",rank:10,action:"Review the deal plan and confirm the next action",reason:"All current rule-based recommendations have already been dismissed or completed, but the open deal still needs one active action.",evidence:[`Current stage: ${coverage.stage.name}.`,`${prior.length} earlier recommendation decisions are recorded.`],priority:"Normal",suggestedOwner:String(deal.owner||"Unassigned"),suggestedDueDate:new Date(now.getTime()+3*86400000).toISOString().slice(0,10),fingerprint:`review-plan:${now.toISOString().slice(0,10)}:${prior.length}`} as RecommendationCandidate}
    await env.DB.batch([
      env.DB.prepare("UPDATE deal_recommendations SET status='Superseded',current_key=NULL,updated_at=? WHERE deal_id=? AND current_key='current'").bind(stamp,dealId),
      env.DB.prepare("INSERT INTO deal_recommendations(id,deal_id,rule_key,fingerprint,action,reason,evidence_json,priority,suggested_owner,suggested_due_date,status,current_key,task_id,generated_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'Active','current',?,?,?) ON CONFLICT(deal_id,fingerprint) DO UPDATE SET action=excluded.action,reason=excluded.reason,evidence_json=excluded.evidence_json,priority=excluded.priority,suggested_owner=excluded.suggested_owner,suggested_due_date=excluded.suggested_due_date,status='Active',current_key='current',task_id=excluded.task_id,accepted_at=NULL,dismissed_at=NULL,completed_at=NULL,decided_by=NULL,decision_note='',generated_at=excluded.generated_at,updated_at=excluded.updated_at").bind(crypto.randomUUID(),dealId,candidate.ruleKey,candidate.fingerprint,candidate.action,candidate.reason,JSON.stringify(candidate.evidence),candidate.priority,candidate.suggestedOwner,candidate.suggestedDueDate,candidate.taskId||null,stamp,stamp),
    ]);
  }
  current=await one(`${recommendationSelect} WHERE r.deal_id=? AND r.current_key='current' LIMIT 1`,dealId);
  const history=await rows(`${recommendationSelect} WHERE r.deal_id=? ORDER BY r.generated_at DESC LIMIT 12`,dealId);
  return {current:recommendationJson(current),history:history.map(item=>recommendationJson(item)),candidateCount:candidates.length};
}

async function prepareMeetingBrief(dealId:number,meetingKey:string,userEmail:string){
  await ensureMeetingRecords(dealId);const deal=await dealRecord(dealId),meeting=meetingKey==="deal"?null:await one("SELECT * FROM deal_meetings WHERE id=? AND deal_id=?",meetingKey,dealId);if(meetingKey!=="deal"&&!meeting)throw new Error("Meeting not found.");
  const [company,notes,activities,tasks,stakeholders,lineItems,insights,reviews,proposals,meetings,attendees]=await Promise.all([
    deal.resolved_company_id?one("SELECT * FROM companies WHERE id=?",Number(deal.resolved_company_id)):Promise.resolve(null),
    rows("SELECT * FROM deal_notes WHERE deal_id=? AND pinned=1 ORDER BY created_at DESC LIMIT 20",dealId),
    rows("SELECT * FROM deal_activities WHERE deal_id=? ORDER BY happened_at DESC LIMIT 40",dealId),
    rows("SELECT * FROM deal_tasks WHERE deal_id=? AND completed=0 ORDER BY due_date LIMIT 30",dealId),
    rows("SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.email,c.title FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? AND s.active=1 ORDER BY s.is_primary DESC,c.first_name",dealId),
    rows("SELECT * FROM deal_line_items WHERE deal_id=?",dealId),
    rows("SELECT * FROM deal_insights WHERE deal_id=? AND status!='Resolved' ORDER BY CASE severity WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,updated_at DESC LIMIT 30",dealId),
    rows("SELECT * FROM deal_reviews WHERE deal_id=? ORDER BY requested_at DESC LIMIT 20",dealId),
    rows("SELECT * FROM deal_proposals WHERE deal_id=? ORDER BY created_at DESC LIMIT 20",dealId),
    rows("SELECT * FROM deal_meetings WHERE deal_id=? ORDER BY starts_at DESC LIMIT 20",dealId),
    meeting?rows("SELECT a.*,c.first_name||' '||c.last_name AS contact_name,c.title AS contact_title FROM deal_meeting_attendees a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.meeting_id=? ORDER BY a.id",String(meeting.id)):Promise.resolve([]),
  ]);
  const health=calculateHealth(deal,tasks,activities,stakeholders,insights,reviews,lineItems),relationship=await relationshipHealth(dealId,deal,tasks,activities,stakeholders),coverage=calculateStakeholderCoverage({deal,stage:await coverageStage(deal),stakeholders,activities}),nextAction=await nextBestAction(dealId,deal,tasks,reviews,proposals,insights,activities,coverage);
  const sourceGroups=[
    {type:"deal",id:String(deal.id),updatedAt:text(deal.updated_at),value:deal,excerpt:`${text(deal.name)} · ${text(deal.stage)} · ${text(deal.next_step)}`},
    ...(company?[{type:"company",id:String(company.id),updatedAt:text(company.updated_at),value:company,excerpt:`${text(company.name)} · ${text(company.industry)} · ${text(company.tier)}`}]:[]),
    ...(meeting?[{type:"meeting",id:String(meeting.id),updatedAt:text(meeting.updated_at),value:meeting,excerpt:`${text(meeting.subject)} · ${text(meeting.status)} · ${text(meeting.starts_at)}`}]:[]),
    {type:"meeting-attendees",id:attendees.map(item=>item.id).join(",")||"none",updatedAt:text(meeting?.updated_at||deal.updated_at),value:attendees,excerpt:attendees.map(item=>text(item.contact_name||item.name||item.email)).join(", ")},
    {type:"deal-activities",id:activities.map(item=>item.id).join(",")||"none",updatedAt:text(activities[0]?.updated_at||activities[0]?.happened_at||deal.updated_at),value:activities,excerpt:activities.slice(0,4).map(item=>`${text(item.type)}: ${text(item.subject)}`).join("; ")},
    {type:"pinned-notes",id:notes.map(item=>item.id).join(",")||"none",updatedAt:text(notes[0]?.updated_at||deal.updated_at),value:notes,excerpt:notes.slice(0,4).map(item=>text(item.body,180)).join("; ")},
    {type:"open-tasks",id:tasks.map(item=>item.id).join(",")||"none",updatedAt:text(tasks[0]?.created_at||deal.updated_at),value:tasks,excerpt:tasks.slice(0,5).map(item=>`${text(item.title)} · ${text(item.due_date)}`).join("; ")},
    {type:"stakeholders",id:stakeholders.map(item=>item.id).join(",")||"none",updatedAt:text(stakeholders[0]?.updated_at||deal.updated_at),value:stakeholders,excerpt:stakeholders.map(item=>`${text(item.contact_name)} (${text(item.role)})`).join(", ")},
    {type:"deal-intelligence",id:insights.map(item=>item.id).join(",")||"none",updatedAt:text(insights[0]?.updated_at||deal.updated_at),value:insights,excerpt:insights.slice(0,5).map(item=>`${text(item.kind)}: ${text(item.title)}`).join("; ")},
    {type:"meeting-history",id:meetings.map(item=>item.id).join(",")||"none",updatedAt:text(meetings[0]?.updated_at||deal.updated_at),value:meetings,excerpt:meetings.slice(0,5).map(item=>`${text(item.subject)} · ${text(item.status)}`).join("; ")},
    {type:"proposals",id:proposals.map(item=>item.id).join(",")||"none",updatedAt:text(proposals[0]?.updated_at||deal.updated_at),value:proposals,excerpt:proposals.slice(0,5).map(item=>`${text(item.title)} · ${text(item.status)}`).join("; ")},
    {type:"reviews",id:reviews.map(item=>item.id).join(",")||"none",updatedAt:text(reviews[0]?.decided_at||reviews[0]?.requested_at||deal.updated_at),value:reviews,excerpt:reviews.slice(0,5).map(item=>`${text(item.review_type)} · ${text(item.status)}`).join("; ")},
    {type:"relationship-health",id:String(relationship.history[0]?.id||"current"),updatedAt:text(relationship.calculatedAt),value:{score:relationship.score,band:relationship.band,provisional:relationship.provisional,meaningfulInteractions:relationship.meaningfulInteractions},excerpt:`${relationship.score}/100 · ${relationship.band}`},
    {type:"stakeholder-coverage",id:"current",updatedAt:text(deal.updated_at),value:{stage:coverage.stage,findings:coverage.findings,keyStakeholders:coverage.keyStakeholders},excerpt:coverage.findings.map(item=>item.title).join("; ")},
    {type:"next-best-action",id:text(nextAction.current?.id||"current"),updatedAt:text(nextAction.current?.updatedAt||deal.updated_at),value:nextAction.current||{},excerpt:text(nextAction.current?.action)},
  ];
  const inputHash=await sha256(JSON.stringify(sourceGroups.map(source=>({type:source.type,id:source.id,updatedAt:source.updatedAt,value:source.value})))),entityId=`${dealId}:${meetingKey}`,cached=await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='meeting-prep' AND a.entity_type='meeting' AND a.entity_id=? AND a.input_hash=? AND a.review_status!='Rejected' ORDER BY a.generated_at DESC LIMIT 1",entityId,inputHash);
  if(cached)return {artifact:meetingArtifact(cached),cached:true};
  const freshness=sourceGroups.map(source=>source.updatedAt).filter(value=>Number.isFinite(Date.parse(value))).sort().at(-1)||new Date().toISOString(),brief=buildMeetingPreparationBrief({deal,company,meeting,attendees,stakeholders,activities,meetings,notes,tasks,insights,reviews,proposals,relationshipHealth:relationship,coverage,nextAction:nextAction.current||null,dealHealth:health,freshnessTime:freshness}),artifactId=crypto.randomUUID(),generatedAt=new Date().toISOString(),confidence=brief.confidence==="High"?90:brief.confidence==="Medium"?70:40,sourcesWithHashes=await Promise.all(sourceGroups.map(async source=>({...source,contentHash:await sha256(JSON.stringify(source.value))})));
  await env.DB.batch([
    env.DB.prepare("UPDATE ai_artifacts SET superseded_by=? WHERE feature='meeting-prep' AND entity_type='meeting' AND entity_id=? AND superseded_by IS NULL").bind(artifactId,entityId),
    env.DB.prepare("INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,review_status,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,rules_version,input_hash,generated_by,generated_at) VALUES (NULLIF(?,''),NULL,'meeting-prep','meeting',?,'Draft',?,?,?,?, 'clientrecord','meeting-prep-rules-v1',1,'meeting-prep-v1',?,?,?)").bind(artifactId,entityId,JSON.stringify(brief),JSON.stringify(brief),"Source-backed deterministic meeting preparation; no external model call was used.",confidence,inputHash,userEmail,generatedAt),
    ...sourcesWithHashes.map(source=>env.DB.prepare("INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,source_updated_at,content_hash,excerpt) VALUES (?,?,?,?,?,?)").bind(artifactId,source.type,source.id.slice(0,1000),source.updatedAt||null,source.contentHash,source.excerpt.slice(0,1000))),
  ]);
  return {artifact:meetingArtifact(await one("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.id=?",artifactId)),cached:false};
}

export async function GET(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  try{
    const url=new URL(request.url);
    if(url.searchParams.get("quality")==="1"){
      const [companyDuplicates,dealDuplicates,unmatchedDeals]=await Promise.all([
        rows(`SELECT a.id AS firstId,a.name AS firstName,b.id AS secondId,b.name AS secondName,
          CASE WHEN a.domain<>'' AND lower(a.domain)=lower(b.domain) THEN 'Matching domain' ELSE 'Similar company name' END AS reason
          FROM companies a JOIN companies b ON a.id<b.id AND ((a.domain<>'' AND lower(a.domain)=lower(b.domain)) OR lower(trim(a.name))=lower(trim(b.name))) ORDER BY a.name LIMIT 100`),
        rows(`SELECT a.id AS firstId,a.name AS firstName,b.id AS secondId,b.name AS secondName,'Matching open deal' AS reason
          FROM deals a JOIN deals b ON a.id<b.id AND lower(trim(a.name))=lower(trim(b.name)) AND COALESCE(a.company_id,0)=COALESCE(b.company_id,0) AND lower(a.company)=lower(b.company) AND a.status='Open' AND b.status='Open' LIMIT 100`),
        rows("SELECT id,name,company FROM deals WHERE company_id IS NULL AND company<>'' ORDER BY updated_at DESC LIMIT 100"),
      ]);
      return Response.json({companyDuplicates,dealDuplicates,unmatchedDeals});
    }
    const dealId=id(url.searchParams.get("dealId")),deal=await dealRecord(dealId);await ensureMeetingRecords(dealId);
    const [company,notes,activities,tasks,history,stakeholders,lineItems,insights,reviews,proposals,documents,unassigned,meetings,meetingAttendees,briefRows]=await Promise.all([
      deal.resolved_company_id?one("SELECT * FROM companies WHERE id=?",Number(deal.resolved_company_id)):Promise.resolve(null),
      rows("SELECT * FROM deal_notes WHERE deal_id=? ORDER BY pinned DESC,created_at DESC",dealId),
      rows("SELECT a.*,c.first_name||' '||c.last_name AS contact_name FROM deal_activities a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.deal_id=? ORDER BY a.pinned DESC,a.happened_at DESC",dealId),
      rows("SELECT * FROM deal_tasks WHERE deal_id=? ORDER BY completed,due_date",dealId),
      rows("SELECT * FROM deal_stage_history WHERE deal_id=? ORDER BY happened_at DESC",dealId),
      rows("SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.email,c.title FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? ORDER BY s.is_primary DESC,c.first_name",dealId),
      rows("SELECT *,quantity*unit_price*(100-discount_percent)/100 AS total FROM deal_line_items WHERE deal_id=? ORDER BY id",dealId),
      rows("SELECT * FROM deal_insights WHERE deal_id=? ORDER BY CASE severity WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,created_at DESC",dealId),
      rows("SELECT * FROM deal_reviews WHERE deal_id=? ORDER BY requested_at DESC",dealId),
      rows("SELECT * FROM deal_proposals WHERE deal_id=? ORDER BY created_at DESC",dealId),
      rows(`SELECT d.*,v.filename,v.content_type,v.size,v.uploaded_at,v.uploaded_by
        FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version
        WHERE d.deal_id=? AND d.status='Active' AND (?=1 OR d.sensitive=0) ORDER BY d.updated_at DESC`,dealId,can(user,"documents.manage_sensitive")?1:0),
      deal.contact_id?rows(`SELECT a.id,a.type,a.note,a.happened_at,c.first_name||' '||c.last_name AS contact_name
        FROM activities a JOIN contacts c ON c.id=a.contact_id WHERE a.contact_id=? AND a.type IN ('Email','Email received','Email sent','Meeting','Calendar meeting','Call')
        AND NOT EXISTS(SELECT 1 FROM deal_activities da WHERE da.source='Contact activity' AND da.external_id=CAST(a.id AS TEXT)) ORDER BY a.happened_at DESC LIMIT 50`,Number(deal.contact_id)):Promise.resolve([]),
      rows("SELECT m.*,d.title AS transcript_title FROM deal_meetings m LEFT JOIN client_documents d ON d.id=m.transcript_document_id WHERE m.deal_id=? ORDER BY m.starts_at DESC",dealId),
      rows("SELECT a.*,c.first_name||' '||c.last_name AS contact_name,c.title AS contact_title FROM deal_meeting_attendees a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.meeting_id IN (SELECT id FROM deal_meetings WHERE deal_id=?) ORDER BY a.id",dealId),
      rows("SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature='meeting-prep' AND a.entity_type='meeting' AND a.entity_id LIKE ? AND a.superseded_by IS NULL AND a.review_status!='Rejected' ORDER BY a.generated_at DESC",`${dealId}:%`),
    ]);
    const health=calculateHealth(deal,tasks,activities,stakeholders,insights,reviews,lineItems),relationship=await relationshipHealth(dealId,deal,tasks,activities,stakeholders),coverage=calculateStakeholderCoverage({deal,stage:await coverageStage(deal),stakeholders,activities}),nextAction=await nextBestAction(dealId,deal,tasks,reviews,proposals,insights,activities,coverage);
    const timeline=[
      ...activities.map(item=>({id:`activity-${item.id}`,kind:"Activity",type:item.type,title:item.subject||item.type,detail:item.body,owner:item.owner,date:item.happened_at,pinned:Boolean(item.pinned)})),
      ...notes.map(item=>({id:`note-${item.id}`,kind:item.kind,title:item.kind,detail:item.body,owner:item.owner,date:item.created_at,pinned:Boolean(item.pinned)})),
      ...tasks.map(item=>({id:`task-${item.id}`,kind:"Task",title:item.title,detail:item.completed?"Completed":`Due ${item.due_date}`,owner:item.owner,date:item.created_at,pinned:false})),
      ...history.map(item=>({id:`stage-${item.id}`,kind:"Stage",title:`${item.from_stage} → ${item.to_stage}`,detail:item.reason,owner:item.actor,date:item.happened_at,pinned:false})),
      ...documents.map(item=>({id:`document-${item.id}`,kind:"Document",title:item.title,detail:`${item.category} · v${item.latest_version}`,owner:item.uploaded_by,date:item.uploaded_at,pinned:false})),
      ...reviews.map(item=>({id:`review-${item.id}`,kind:"Review",title:`${item.review_type}: ${item.status}`,detail:item.comments,owner:item.approver,date:item.decided_at||item.requested_at,pinned:false})),
    ].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||String(b.date).localeCompare(String(a.date)));
    const attendeeMap=new Map<string,Row[]>();for(const attendee of meetingAttendees){const key=String(attendee.meeting_id),group=attendeeMap.get(key)||[];group.push(attendee);attendeeMap.set(key,group)}
    const briefMap:Record<string,ReturnType<typeof meetingArtifact>>={};for(const artifact of briefRows){const parsed=meetingArtifact(artifact);if(parsed&&!briefMap[parsed.meetingKey])briefMap[parsed.meetingKey]=parsed}
    return Response.json({deal,company,health,relationshipHealth:relationship,stakeholderCoverage:coverage,nextBestAction:nextAction,stakeholderRoles:dealStakeholderRoles,notes,activities,tasks,history,stakeholders,lineItems,insights,reviews,proposals,documents,unassigned,meetings:meetings.map(meeting=>({...meeting,attendees:attendeeMap.get(String(meeting.id))||[]})),meetingBriefs:briefMap,timeline,permissions:{edit:can(user,"records.edit"),delete:can(user,"records.delete"),upload:can(user,"documents.upload"),sensitive:can(user,"documents.manage_sensitive"),aiReview:can(user,"ai.review"),admin:canAdmin(user.role)}});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Deal workspace could not load."},{status:400})}
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  if(!can(user,"records.edit"))return Response.json({error:"Record-edit permission is required."},{status:403});
  try{
    const body=await request.json() as Row,action=text(body.action,80),now=new Date().toISOString(),dealId=body.dealId?id(body.dealId):0;
    if(dealId)await dealRecord(dealId);
    if(action==="saveNote"){
      const content=text(body.body);if(!content)throw new Error("Enter a note or comment.");
      const result=await env.DB.prepare("INSERT INTO deal_notes(deal_id,kind,body,owner,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(dealId,text(body.kind,30)||"Note",content,user.email,bool(body.pinned)?1:0,now,now).run();
      await audit(user,action,"deal_note",result.meta.last_row_id,"Added a deal note",{dealId,kind:body.kind,pinned:bool(body.pinned)});
    }else if(action==="toggleNotePin"){
      const noteId=id(body.id),before=await one("SELECT * FROM deal_notes WHERE id=? AND deal_id=?",noteId,dealId);if(!before)throw new Error("Note not found.");
      await env.DB.prepare("UPDATE deal_notes SET pinned=?,updated_at=? WHERE id=?").bind(bool(body.pinned)?1:0,now,noteId).run();await audit(user,action,"deal_note",noteId,"Changed pinned note status",{before,after:{pinned:bool(body.pinned)}});
    }else if(action==="saveActivity"){
      const type=text(body.type,50),content=text(body.body),happened=text(body.happenedAt,40)||now;if(!type||!content||!Number.isFinite(Date.parse(happened)))throw new Error("Activity type, details, and a valid date are required.");
      const deal=await dealRecord(dealId),contactId=body.contactId?id(body.contactId):deal.contact_id?Number(deal.contact_id):null,follow=text(body.followUpAt,20)||null;
      const result=await env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,follow_up_at,source,thread_key,external_id,response_expected,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(dealId,deal.resolved_company_id?Number(deal.resolved_company_id):null,contactId,type,text(body.subject,240),content,text(body.owner,200)||user.email,text(body.outcome,1000),new Date(happened).toISOString(),follow,"Manual",text(body.threadKey,240)||null,null,bool(body.responseExpected)?1:0,bool(body.pinned)?1:0,now,now).run();
      if(follow)await env.DB.prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,created_at) VALUES (?,?,?,?,?)").bind(dealId,text(body.followUpTitle,240)||`Follow up: ${text(body.subject,180)||type}`,text(body.owner,200)||user.email,follow.slice(0,10),now).run();
      await audit(user,action,"deal_activity",result.meta.last_row_id,`Recorded ${type}`,{dealId,contactId,outcome:body.outcome,followUpAt:follow,responseExpected:bool(body.responseExpected)});
    }else if(action==="saveMeeting"){
      const meetingId=text(body.id,100)||crypto.randomUUID(),before=await one("SELECT * FROM deal_meetings WHERE id=? AND deal_id=?",meetingId,dealId),subject=text(body.subject,240),status=text(body.status,30)||"Scheduled",startsAt=text(body.startsAt,50),endsAt=text(body.endsAt,50)||null,sourceProvider=text(body.sourceProvider,40)||"Manual";
      if(!subject||!Number.isFinite(Date.parse(startsAt)))throw new Error("Meeting subject and a valid start time are required.");if(endsAt&&(!Number.isFinite(Date.parse(endsAt))||Date.parse(endsAt)<Date.parse(startsAt)))throw new Error("Meeting end time must be after the start time.");if(!["Scheduled","Completed","Cancelled"].includes(status))throw new Error("Choose scheduled, completed, or cancelled.");if(!["Manual","Google","Microsoft","Meetily","Granola","Other"].includes(sourceProvider))throw new Error("Choose a supported meeting source.");
      const externalId=text(body.externalId,240)||null;if(externalId&&!before){const duplicate=await one("SELECT id FROM deal_meetings WHERE source_provider=? AND external_id=?",sourceProvider,externalId);if(duplicate)throw new Error("This provider meeting has already been imported.")}
      const attendeeIds=[...new Set(stringList(body.attendeeIds).map(value=>id(value)))],attendees=attendeeIds.length?await rows(`SELECT id,first_name||' '||last_name AS name,email FROM contacts WHERE id IN (${attendeeIds.map(()=>"?").join(",")})`,...attendeeIds):[];if(attendees.length!==attendeeIds.length)throw new Error("One or more attendees could not be found.");
      const transcriptDocumentId=text(body.transcriptDocumentId,100)||null;if(transcriptDocumentId&&!await one("SELECT id FROM client_documents WHERE id=? AND deal_id=? AND status='Active'",transcriptDocumentId,dealId))throw new Error("Choose a transcript document associated with this deal.");
      const deal=await dealRecord(dealId),summary=text(body.summary,12000),decisions=stringList(body.decisions),customerCommitments=stringList(body.customerCommitments),internalCommitments=stringList(body.internalCommitments),risksObjections=stringList(body.risksObjections),nextSteps=stringList(body.nextSteps).map(value=>({text:value,owner:text(body.nextStepOwner,200)||text(deal.owner,200)||user.email,dueDate:text(body.nextStepDueDate,20)||null}));
      let activityId=before?.activity_id?Number(before.activity_id):null;
      if(activityId)await env.DB.prepare("UPDATE deal_activities SET contact_id=?,subject=?,body=?,owner=?,outcome=?,happened_at=?,source=?,external_id=?,updated_at=? WHERE id=? AND deal_id=?").bind(attendeeIds[0]||null,subject,summary||subject,text(body.owner,200)||user.email,status,startsAt,sourceProvider,externalId,now,activityId,dealId).run();
      else {const activity=await env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,source,external_id,pinned,created_at,updated_at) VALUES (?,?,?,'Meeting',?,?,?,?,?,?,?,0,?,?)").bind(dealId,deal.resolved_company_id?Number(deal.resolved_company_id):null,attendeeIds[0]||null,subject,summary||subject,text(body.owner,200)||user.email,status,startsAt,sourceProvider,externalId,now,now).run();activityId=Number(activity.meta.last_row_id)}
      if(before)await env.DB.prepare("UPDATE deal_meetings SET company_id=?,activity_id=?,subject=?,status=?,starts_at=?,ends_at=?,owner=?,summary=?,decisions_json=?,customer_commitments_json=?,internal_commitments_json=?,risks_objections_json=?,next_steps_json=?,transcript_document_id=?,source_provider=?,external_id=?,updated_at=? WHERE id=? AND deal_id=?").bind(deal.resolved_company_id?Number(deal.resolved_company_id):null,activityId,subject,status,startsAt,endsAt,text(body.owner,200)||user.email,summary,JSON.stringify(decisions),JSON.stringify(customerCommitments),JSON.stringify(internalCommitments),JSON.stringify(risksObjections),JSON.stringify(nextSteps),transcriptDocumentId,sourceProvider,externalId,now,meetingId,dealId).run();
      else await env.DB.prepare("INSERT INTO deal_meetings(id,deal_id,company_id,activity_id,subject,status,starts_at,ends_at,owner,summary,decisions_json,customer_commitments_json,internal_commitments_json,risks_objections_json,next_steps_json,transcript_document_id,source_provider,external_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(meetingId,dealId,deal.resolved_company_id?Number(deal.resolved_company_id):null,activityId,subject,status,startsAt,endsAt,text(body.owner,200)||user.email,summary,JSON.stringify(decisions),JSON.stringify(customerCommitments),JSON.stringify(internalCommitments),JSON.stringify(risksObjections),JSON.stringify(nextSteps),transcriptDocumentId,sourceProvider,externalId,user.email,now,now).run();
      await env.DB.prepare("DELETE FROM deal_meeting_attendees WHERE meeting_id=?").bind(meetingId).run();if(attendees.length)await env.DB.batch(attendees.map(attendee=>env.DB.prepare("INSERT INTO deal_meeting_attendees(meeting_id,contact_id,name,email,role,created_at) VALUES (?,?,?,?,?,?)").bind(meetingId,Number(attendee.id),text(attendee.name,240),text(attendee.email,320),"Attendee",now)));
      await audit(user,action,"deal_meeting",meetingId,before?"Updated structured meeting record":"Created structured meeting record",{dealId,before,after:{subject,status,startsAt,endsAt,attendeeIds,sourceProvider,transcriptDocumentId,decisions,customerCommitments,internalCommitments,risksObjections,nextSteps}});
      return Response.json({ok:true,id:meetingId});
    }else if(action==="prepareMeeting"){
      const meetingKey=text(body.meetingId,100)||"deal",result=await prepareMeetingBrief(dealId,meetingKey,user.email);await audit(user,action,"meeting_prep_brief",String(result.artifact?.id||meetingKey),result.cached?"Used cached meeting-preparation brief":"Generated meeting-preparation brief",{dealId,meetingKey,cached:result.cached,inputHash:result.artifact?.inputHash,sourceCount:result.artifact?.sourceCount});return Response.json({ok:true,...result});
    }else if(action==="reviewMeetingBrief"){
      if(!can(user,"ai.review"))return Response.json({error:"AI review permission is required."},{status:403});const artifactId=text(body.id,100),status=text(body.status,20);if(!["Accepted","Rejected"].includes(status))throw new Error("Choose accepted or rejected.");const artifact=await one("SELECT * FROM ai_artifacts WHERE id=? AND feature='meeting-prep' AND entity_id LIKE ?",artifactId,`${dealId}:%`);if(!artifact)throw new Error("Meeting brief not found.");const before=JSON.stringify({reviewStatus:artifact.review_status,contentJson:artifact.content_json}),after=JSON.stringify({reviewStatus:status,contentJson:artifact.content_json});await env.DB.batch([env.DB.prepare("INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,?)").bind(artifactId,status,before,after,text(body.comment),user.email,now),env.DB.prepare("UPDATE ai_artifacts SET review_status=?,reviewed_by=?,reviewed_at=? WHERE id=?").bind(status,user.email,now,artifactId)]);await audit(user,action,"ai_artifact",artifactId,`${status} meeting-preparation brief`,{dealId,status});
    }else if(action==="linkContactActivity"){
      const sourceId=id(body.activityId),source=await one("SELECT * FROM activities WHERE id=?",sourceId);if(!source)throw new Error("Activity not found.");const deal=await dealRecord(dealId);
      await env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,source,external_id,pinned,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'Contact activity',?,0,?,?)").bind(dealId,deal.resolved_company_id?Number(deal.resolved_company_id):null,Number(source.contact_id),String(source.type),String(source.note).slice(0,240),String(source.note),user.email,"",String(source.happened_at),String(sourceId),now,now).run();
      await audit(user,action,"deal_activity",dealId,"Associated contact activity with deal",{sourceId});
    }else if(action==="saveStakeholder"){
      const contactId=id(body.contactId),role=text(body.role,80),primary=bool(body.isPrimary),isActive=primary||!Object.hasOwn(body,"active")||bool(body.active);if(!dealStakeholderRoles.includes(role as (typeof dealStakeholderRoles)[number]))throw new Error("Choose a standard stakeholder role.");if(primary)await env.DB.prepare("UPDATE deal_stakeholders SET is_primary=0 WHERE deal_id=?").bind(dealId).run();
      await env.DB.prepare("INSERT INTO deal_stakeholders(deal_id,contact_id,role,notes,is_primary,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(deal_id,contact_id) DO UPDATE SET role=excluded.role,notes=excluded.notes,is_primary=excluded.is_primary,active=excluded.active,updated_at=excluded.updated_at").bind(dealId,contactId,role,text(body.notes,2000),primary?1:0,isActive?1:0,now,now).run();
      if(primary)await env.DB.prepare("UPDATE deals SET contact_id=?,updated_at=? WHERE id=?").bind(contactId,now,dealId).run();await audit(user,action,"deal_stakeholder",contactId,"Updated deal stakeholder",{dealId,role,isPrimary:primary,active:isActive});
    }else if(action==="toggleStakeholderActive"){
      const stakeholderId=id(body.id),before=await one("SELECT * FROM deal_stakeholders WHERE id=? AND deal_id=?",stakeholderId,dealId);if(!before)throw new Error("Stakeholder not found.");const isActive=bool(body.active);
      await env.DB.batch([env.DB.prepare("UPDATE deal_stakeholders SET active=?,is_primary=CASE WHEN ?=0 THEN 0 ELSE is_primary END,updated_at=? WHERE id=? AND deal_id=?").bind(isActive?1:0,isActive?1:0,now,stakeholderId,dealId),...(!isActive&&before.is_primary?[env.DB.prepare("UPDATE deals SET contact_id=NULL,updated_at=? WHERE id=? AND contact_id=?").bind(now,dealId,Number(before.contact_id))]:[])]);await audit(user,action,"deal_stakeholder",stakeholderId,isActive?"Restored deal stakeholder":"Marked deal stakeholder inactive",{dealId,before,active:isActive});
    }else if(action==="removeStakeholder"){
      const stakeholderId=id(body.id);if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});const before=await one("SELECT * FROM deal_stakeholders WHERE id=? AND deal_id=?",stakeholderId,dealId);if(!before)throw new Error("Stakeholder not found.");await env.DB.batch([env.DB.prepare("DELETE FROM deal_stakeholders WHERE id=? AND deal_id=?").bind(stakeholderId,dealId),...(before.is_primary?[env.DB.prepare("UPDATE deals SET contact_id=NULL,updated_at=? WHERE id=? AND contact_id=?").bind(now,dealId,Number(before.contact_id))]:[])]);await audit(user,action,"deal_stakeholder",stakeholderId,"Removed deal stakeholder",{dealId,before});
    }else if(action==="saveLineItem"){
      const result=await env.DB.prepare("INSERT INTO deal_line_items(deal_id,name,sku,quantity,unit_price,discount_percent,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(dealId,text(body.name,240)||"Line item",text(body.sku,120),Math.max(1,Math.round(Number(body.quantity)||1)),money(body.unitPrice),Math.min(100,Math.max(0,Math.round(Number(body.discountPercent)||0))),text(body.notes,1000),now,now).run();await audit(user,action,"deal_line_item",result.meta.last_row_id,"Added a deal line item",{dealId,name:body.name});
    }else if(action==="deleteLineItem"){
      if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});const lineId=id(body.id);await env.DB.prepare("DELETE FROM deal_line_items WHERE id=? AND deal_id=?").bind(lineId,dealId).run();await audit(user,action,"deal_line_item",lineId,"Deleted a deal line item",{dealId});
    }else if(action==="syncDealValue"){
      const total=await one("SELECT COALESCE(SUM(quantity*unit_price*(100-discount_percent)/100),0) AS total FROM deal_line_items WHERE deal_id=?",dealId);await env.DB.prepare("UPDATE deals SET value=?,updated_at=? WHERE id=?").bind(Number(total?.total||0),now,dealId).run();await audit(user,action,"deal",dealId,"Updated deal value from line items",{value:total?.total});
    }else if(action==="saveInsight"){
      const kind=text(body.kind,60);if(!["Competitor","Risk","Objection","Decision criterion"].includes(kind))throw new Error("Choose a valid insight type.");const result=await env.DB.prepare("INSERT INTO deal_insights(deal_id,kind,title,detail,severity,status,owner,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(dealId,kind,text(body.title,240)||kind,text(body.detail),text(body.severity,20)||"Medium",text(body.status,30)||"Open",text(body.owner,200)||user.email,now,now).run();await audit(user,action,"deal_insight",result.meta.last_row_id,`Added ${kind.toLowerCase()}`,{dealId,title:body.title});
    }else if(action==="resolveInsight"){
      const insightId=id(body.id);await env.DB.prepare("UPDATE deal_insights SET status=?,updated_at=? WHERE id=? AND deal_id=?").bind(text(body.status,30)||"Resolved",now,insightId,dealId).run();await audit(user,action,"deal_insight",insightId,"Updated deal insight status",{dealId,status:body.status});
    }else if(action==="requestReview"){
      const result=await env.DB.prepare("INSERT INTO deal_reviews(deal_id,review_type,status,approver,requested_by,comments,requested_at) VALUES (?,?,'Requested',?,?,?,?)").bind(dealId,text(body.reviewType,100)||"Deal review",text(body.approver,200)||user.email,user.email,text(body.comments,2000),now).run();await audit(user,action,"deal_review",result.meta.last_row_id,"Requested deal approval",{dealId,approver:body.approver});
    }else if(action==="decideReview"){
      const reviewId=id(body.id),status=text(body.status,20);if(!["Approved","Rejected"].includes(status))throw new Error("Choose approved or rejected.");await env.DB.prepare("UPDATE deal_reviews SET status=?,comments=?,decided_at=? WHERE id=? AND deal_id=?").bind(status,text(body.comments,2000),now,reviewId,dealId).run();await audit(user,action,"deal_review",reviewId,`${status} deal review`,{dealId,status});
    }else if(action==="saveProposal"){
      const result=await env.DB.prepare("INSERT INTO deal_proposals(deal_id,title,amount,status,valid_until,document_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(dealId,text(body.title,240)||"Proposal",money(body.amount),text(body.status,30)||"Draft",text(body.validUntil,20)||null,text(body.documentId,80)||null,user.email,now,now).run();await audit(user,action,"deal_proposal",result.meta.last_row_id,"Added quote or proposal",{dealId,title:body.title,amount:body.amount});
    }else if(action==="recommendationDecision"){
      const recommendationId=text(body.id,80),decision=text(body.decision,20),record=await one("SELECT * FROM deal_recommendations WHERE id=? AND deal_id=? AND current_key='current'",recommendationId,dealId);if(!record)throw new Error("The active recommendation was not found.");if(!["Accept","Dismiss","Complete"].includes(decision))throw new Error("Choose accept, dismiss, or complete.");const note=text(body.note,1000),createTask=decision==="Accept"&&bool(body.createTask);
      if(createTask&&!record.task_id){await env.DB.batch([env.DB.prepare("INSERT INTO deal_tasks(deal_id,title,owner,due_date,created_at) VALUES (?,?,?,?,?)").bind(dealId,String(record.action),String(record.suggested_owner||user.email),String(record.suggested_due_date),now),env.DB.prepare("UPDATE deal_recommendations SET status='Accepted',task_id=last_insert_rowid(),accepted_at=COALESCE(accepted_at,?),decided_by=?,decision_note=?,updated_at=? WHERE id=? AND deal_id=?").bind(now,user.email,note,now,recommendationId,dealId)])}
      else if(decision==="Accept")await env.DB.prepare("UPDATE deal_recommendations SET status='Accepted',accepted_at=COALESCE(accepted_at,?),decided_by=?,decision_note=?,updated_at=? WHERE id=? AND deal_id=?").bind(now,user.email,note,now,recommendationId,dealId).run();
      else if(decision==="Dismiss")await env.DB.prepare("UPDATE deal_recommendations SET status='Dismissed',current_key=NULL,dismissed_at=?,decided_by=?,decision_note=?,updated_at=? WHERE id=? AND deal_id=?").bind(now,user.email,note,now,recommendationId,dealId).run();
      else {await env.DB.batch([env.DB.prepare("UPDATE deal_recommendations SET status='Completed',current_key=NULL,completed_at=?,decided_by=?,decision_note=?,updated_at=? WHERE id=? AND deal_id=?").bind(now,user.email,note,now,recommendationId,dealId),...(record.task_id?[env.DB.prepare("UPDATE deal_tasks SET completed=1 WHERE id=? AND deal_id=?").bind(Number(record.task_id),dealId)]:[])])}
      await audit(user,action,"deal_recommendation",recommendationId,`${decision==="Complete"?"Completed":decision+"ed"} next-best action`,{dealId,decision,createTask,note,ruleKey:record.rule_key});
    }else if(action==="mergeCompany"){
      if(!canAdmin(user.role))return Response.json({error:"Admin access is required."},{status:403});const sourceId=id(body.sourceId),targetId=id(body.targetId);if(sourceId===targetId)throw new Error("Choose two different companies.");const source=await one("SELECT * FROM companies WHERE id=?",sourceId),target=await one("SELECT * FROM companies WHERE id=?",targetId);if(!source||!target)throw new Error("Company not found.");
      await env.DB.batch([
        env.DB.prepare("UPDATE contacts SET company=?,updated_at=? WHERE lower(company)=lower(?)").bind(String(target.name),now,String(source.name)),
        env.DB.prepare("UPDATE deals SET company_id=?,company=?,updated_at=? WHERE company_id=? OR lower(company)=lower(?)").bind(targetId,String(target.name),now,sourceId,String(source.name)),
        env.DB.prepare("UPDATE account_signals SET company_id=? WHERE company_id=?").bind(targetId,sourceId),
        env.DB.prepare("UPDATE qualification_alerts SET company_id=? WHERE company_id=?").bind(targetId,sourceId),
        env.DB.prepare("UPDATE deal_activities SET company_id=? WHERE company_id=?").bind(targetId,sourceId),
        env.DB.prepare("UPDATE client_documents SET company_id=?,updated_at=? WHERE company_id=?").bind(targetId,now,sourceId),
        env.DB.prepare("INSERT INTO account_stakeholders(company_id,contact_id,role,notes) SELECT ?,contact_id,role,notes FROM account_stakeholders WHERE company_id=? ON CONFLICT(company_id,contact_id) DO UPDATE SET notes=account_stakeholders.notes||char(10)||excluded.notes").bind(targetId,sourceId),
        env.DB.prepare("DELETE FROM account_stakeholders WHERE company_id=?").bind(sourceId),
        env.DB.prepare("DELETE FROM companies WHERE id=?").bind(sourceId),
      ]);await audit(user,action,"company",targetId,`Merged ${source.name} into ${target.name}`,{sourceId,targetId});
    }else if(action==="repairRelationships"){
      if(!canAdmin(user.role))return Response.json({error:"Admin access is required."},{status:403});const result=await env.DB.prepare("UPDATE deals SET company_id=(SELECT id FROM companies WHERE lower(name)=lower(deals.company) LIMIT 1) WHERE company_id IS NULL AND company<>''").run();await audit(user,action,"deal","bulk","Matched deals to company records",{updated:result.meta.changes});return Response.json({ok:true,updated:result.meta.changes});
    }else if(action==="enrichCompany"){
      const companyId=id(body.companyId),company=await one("SELECT * FROM companies WHERE id=?",companyId);if(!company)throw new Error("Company not found.");let domain=text(company.domain,240).toLowerCase();if(!domain&&company.website){try{domain=new URL(String(company.website)).hostname.replace(/^www\./,"").toLowerCase()}catch{}}if(!domain)throw new Error("Add a company website before enriching the record.");const updated=await env.DB.prepare("UPDATE contacts SET company=?,updated_at=? WHERE company='' AND lower(substr(email,instr(email,'@')+1))=?").bind(String(company.name),now,domain).run();await env.DB.prepare("UPDATE companies SET domain=?,updated_at=? WHERE id=?").bind(domain,now,companyId).run();await audit(user,action,"company",companyId,"Enriched company from its domain",{domain,contactsMatched:updated.meta.changes});return Response.json({ok:true,domain,contactsMatched:updated.meta.changes});
    }else throw new Error("Unknown deal workspace action.");
    return Response.json({ok:true});
  }catch(error){const message=error instanceof Error?error.message:"The change could not be saved.";return Response.json({error:/SQLITE|constraint/i.test(message)?"The change conflicts with an existing or missing record.":message},{status:400})}
}
