type Row=Record<string,unknown>;

export type Confidence="Low"|"Medium"|"High";
export type DealReview={
  headline:string; whatChanged:string[]; evidence:string[]; risks:string[]; missingQualification:string[];
  closeDateCredibility:{rating:"Strong"|"Watch"|"Weak";reason:string}; actions:string[]; confidence:Confidence; explanation:string; dataGaps:string[];
};
export type ForecastExplanation={
  headline:string; forecastTotal:number; commitTotal:number; bestCaseTotal:number; pipelineTotal:number;
  movements:string[]; closeDateRisks:string[]; commitDrivers:string[]; coverageGaps:string[]; actions:string[];
  confidence:Confidence; explanation:string; dataGaps:string[];
};

const clean=(value:unknown,max=1600)=>String(value??"").trim().slice(0,max);
const list=(value:unknown,max=12)=>Array.isArray(value)?value.map(item=>clean(item,1800)).filter(Boolean).slice(0,max):[];
const daysAgo=(value:unknown)=>{const time=Date.parse(clean(value,80));return Number.isFinite(time)?Math.max(0,Math.floor((Date.now()-time)/86400000)):null};
const money=(value:unknown)=>Math.max(0,Math.round(Number(value)||0));
const date=(value:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(clean(value,10))?clean(value,10):"";
const isPast=(value:unknown)=>{const day=date(value);return Boolean(day&&day<new Date().toISOString().slice(0,10));};

export function normalizeDealReview(value:unknown):DealReview{
  const row=(value&&typeof value==="object"?value:{}) as Row,close=(row.closeDateCredibility&&typeof row.closeDateCredibility==="object"?row.closeDateCredibility:{}) as Row;
  const rating=clean(close.rating,20);
  return {headline:clean(row.headline,300)||"Deal review",whatChanged:list(row.whatChanged),evidence:list(row.evidence),risks:list(row.risks),missingQualification:list(row.missingQualification),closeDateCredibility:{rating:rating==="Strong"||rating==="Watch"?rating:"Weak",reason:clean(close.reason,900)},actions:list(row.actions,8),confidence:confidence(row.confidence),explanation:clean(row.explanation,3000),dataGaps:list(row.dataGaps)};
}
export function normalizeForecastExplanation(value:unknown):ForecastExplanation{
  const row=(value&&typeof value==="object"?value:{}) as Row;
  return {headline:clean(row.headline,300)||"Forecast explanation",forecastTotal:money(row.forecastTotal),commitTotal:money(row.commitTotal),bestCaseTotal:money(row.bestCaseTotal),pipelineTotal:money(row.pipelineTotal),movements:list(row.movements),closeDateRisks:list(row.closeDateRisks),commitDrivers:list(row.commitDrivers),coverageGaps:list(row.coverageGaps),actions:list(row.actions,8),confidence:confidence(row.confidence),explanation:clean(row.explanation,3000),dataGaps:list(row.dataGaps)};
}
function confidence(value:unknown):Confidence{const item=clean(value,20);return item==="High"||item==="Medium"?item:"Low";}
function stakeholderGaps(stakeholders:Row[]){
  const roles=new Set(stakeholders.filter(item=>Boolean(item.active)).map(item=>clean(item.role,80).toLowerCase()));
  const gaps:string[]=[];if(!stakeholders.filter(item=>Boolean(item.active)).length)gaps.push("No active deal stakeholders are recorded.");
  if(!roles.has("decision-maker"))gaps.push("No decision-maker is recorded.");
  if(!roles.has("champion"))gaps.push("No champion is recorded.");
  if(!roles.has("economic buyer"))gaps.push("No economic buyer is recorded.");return gaps;
}

export function buildDealReview(input:{deal:Row;stageHistory:Row[];activities:Row[];meetings:Row[];tasks:Row[];insights:Row[];stakeholders:Row[];relationship:Row|null;recommendation:Row|null;aiFields:Row[]}){
  const deal=input.deal,name=clean(deal.name,240)||"This deal",changes:string[]=[],evidence:string[]=[],risks:string[]=[],dataGaps:string[]=[],qualification=stakeholderGaps(input.stakeholders);
  const latestStage=input.stageHistory[0],latestActivity=input.activities[0],latestMeeting=input.meetings[0],overdue=input.tasks.filter(item=>!Boolean(item.completed)&&date(item.due_date)&&isPast(item.due_date));
  if(latestStage&&daysAgo(latestStage.happened_at)!==null&&daysAgo(latestStage.happened_at)!<=7)changes.push(`Stage moved from ${clean(latestStage.from_stage,120)||"Created"} to ${clean(latestStage.to_stage,120)||clean(deal.stage,120)} in the last 7 days.`);
  if(latestActivity){const age=daysAgo(latestActivity.happened_at);evidence.push(`${clean(latestActivity.type,80)||"Activity"}: ${clean(latestActivity.subject||latestActivity.body,220)||"Recorded customer activity"}${age!==null?` (${age} day${age===1?"":"s"} ago)`:""}.`)}
  if(latestMeeting)evidence.push(`Latest meeting: ${clean(latestMeeting.subject,220)||"Meeting"}${clean(latestMeeting.starts_at,80)?` on ${clean(latestMeeting.starts_at,80).slice(0,10)}`:""}.`);
  const health=Number(input.relationship?.score??input.relationship?.relationship_score);if(Number.isFinite(health)&&health<60)risks.push(`Relationship health is ${health}/100${health<40?", which is at-risk":" and needs attention"}.`);
  if(overdue.length)risks.push(`${overdue.length} follow-up${overdue.length===1?" is":"s are"} overdue.`);
  if(!clean(deal.next_step,400))risks.push("No next step is recorded.");
  if(isPast(deal.close_date))risks.push(`Expected close date ${date(deal.close_date)} has passed.`);
  if(!date(deal.close_date))dataGaps.push("No expected close date is recorded.");
  const meaningful=[...input.activities,...input.meetings].map(item=>daysAgo(item.happened_at??item.starts_at)).filter((item):item is number=>item!==null);
  const lastMeaningful=meaningful.length?Math.min(...meaningful):null;if(lastMeaningful===null){risks.push("No customer meeting or deal activity is recorded.");dataGaps.push("No meaningful interaction is available to assess engagement.")}else if(lastMeaningful>21)risks.push(`No meaningful interaction has been recorded for ${lastMeaningful} days.`);
  input.insights.filter(item=>clean(item.status,40)!=="Resolved"&&["Risk","Objection"].includes(clean(item.kind,60))).slice(0,4).forEach(item=>risks.push(`${clean(item.kind,60)}: ${clean(item.title||item.detail,260)}`));
  const meddpicc=input.aiFields.find(item=>clean(item.field_key,80)==="meddpicc");if(meddpicc&&!clean(meddpicc.value_json,200).includes("Confirmed"))qualification.push("MEDDPICC is incomplete; review the AI field evidence before advancing.");
  const rating:DealReview["closeDateCredibility"]["rating"]=isPast(deal.close_date)||!date(deal.close_date)||lastMeaningful===null||lastMeaningful>21?"Weak":overdue.length||qualification.length>2?"Watch":"Strong";
  const closeReason=rating==="Strong"?"A future close date, recent engagement, and follow-up coverage are recorded.":isPast(deal.close_date)?"The close date has passed without a recorded closed outcome.":!date(deal.close_date)?"There is no expected close date to test.":lastMeaningful===null?"There is no meaningful customer interaction recorded.":lastMeaningful>21?`The last meaningful interaction was ${lastMeaningful} days ago.`:"Qualification or follow-up gaps weaken the date.";
  const actions=[clean(input.recommendation?.recommended_action||input.recommendation?.action,280),overdue.length?`Complete the overdue follow-up${overdue.length===1?"":"s"}.`:"",qualification[0]?qualification[0].replace(/^No /,"Add a ").replace(" is recorded.","."):"",!clean(deal.next_step,400)?"Record a specific next step and owner.":""].filter(Boolean).slice(0,4);
  const confidence:Confidence=dataGaps.length>=2?"Low":qualification.length>2||lastMeaningful===null?"Medium":"High";
  return normalizeDealReview({headline:`${name}: ${rating=== "Weak"?"needs a close-date reset":rating==="Watch"?"needs attention":"is positioned to progress"}`,whatChanged:changes.length?changes:["No material stage movement was recorded in the last 7 days."],evidence:evidence.length?evidence:["No recent customer-facing activity is recorded."],risks,missingQualification:qualification,closeDateCredibility:{rating,reason:closeReason},actions:actions.length?actions:["Review the deal with the owner and record the next customer commitment."],confidence,explanation:"This review uses only the deal record, stage history, customer activities, meetings, tasks, stakeholder roles, relationship health, recommendations, risks, and approved AI qualification fields.",dataGaps});
}

export function buildForecastExplanation(input:{deals:Row[];stageHistory:Row[]}){
  const open=input.deals.filter(item=>clean(item.status,50)==="Open"),byCategory=(category:string)=>open.filter(item=>clean(item.forecast_category,80).toLowerCase()===category).reduce((sum,item)=>sum+money(item.value),0),weighted=open.reduce((sum,item)=>sum+money(item.value)*Number(item.probability||0)/100,0),commit=open.filter(item=>clean(item.forecast_category,80).toLowerCase()==="commit"),recentMoves=input.stageHistory.filter(item=>{const age=daysAgo(item.happened_at);return age!==null&&age<=7});
  const closeRisks=open.filter(item=>isPast(item.close_date)||!date(item.close_date)).slice(0,8).map(item=>`${clean(item.name,180)}: ${isPast(item.close_date)?`close date ${date(item.close_date)} has passed`:"no expected close date"}.`);
  const coverage:string[]=[];if(!commit.length)coverage.push("No open deal is currently marked Commit.");if(open.filter(item=>!clean(item.owner,240)).length)coverage.push(`${open.filter(item=>!clean(item.owner,240)).length} open deal(s) have no owner.`);if(open.filter(item=>!clean(item.next_step,400)).length)coverage.push(`${open.filter(item=>!clean(item.next_step,400)).length} open deal(s) have no next step.`);if(!open.length)coverage.push("There are no open deals in the forecast.");
  const drivers=commit.slice().sort((a,b)=>money(b.value)-money(a.value)).slice(0,5).map(item=>`${clean(item.name,180)} — $${(money(item.value)/100).toLocaleString("en-US")} at ${Number(item.probability||0)}% (${clean(item.stage,100)}).`);
  const movements=recentMoves.slice(0,8).map(item=>`${clean(item.deal_name||item.name,180)||"Deal"}: ${clean(item.from_stage,80)||"Created"} → ${clean(item.to_stage,80)||"updated stage"}.`);
  const confidence:Confidence=!open.length?"Low":coverage.length>2?"Medium":"High";
  return normalizeForecastExplanation({headline:commit.length?`Commit is carried by ${commit.length} open deal${commit.length===1?"":"s"}.`:`The forecast has no committed revenue yet.`,forecastTotal:Math.round(weighted),commitTotal:byCategory("commit"),bestCaseTotal:byCategory("best case"),pipelineTotal:byCategory("pipeline"),movements:movements.length?movements:["No stage movements were recorded in the last 7 days."],closeDateRisks:closeRisks,commitDrivers:drivers,coverageGaps:coverage,actions:[closeRisks.length?"Review passed or missing close dates before the next forecast call.":"",coverage.some(item=>item.includes("next step"))?"Require a specific next step on uncovered open deals.":"",!commit.length&&open.length?"Set a forecast category after reviewing the strongest active opportunities.":""].filter(Boolean),confidence,explanation:"This forecast explanation uses open deal value, probability, forecast category, stage, close date, owner, next step, and the latest recorded stage movements. It does not predict revenue beyond the CRM evidence.",dataGaps:coverage.filter(item=>item.includes("no ")||item.includes("No "))});
}

export const dealReviewSchema={type:"object",additionalProperties:false,properties:{headline:{type:"string"},whatChanged:{type:"array",items:{type:"string"}},evidence:{type:"array",items:{type:"string"}},risks:{type:"array",items:{type:"string"}},missingQualification:{type:"array",items:{type:"string"}},closeDateCredibility:{type:"object",additionalProperties:false,properties:{rating:{type:"string",enum:["Strong","Watch","Weak"]},reason:{type:"string"}},required:["rating","reason"]},actions:{type:"array",items:{type:"string"}},confidence:{type:"string",enum:["Low","Medium","High"]},explanation:{type:"string"},dataGaps:{type:"array",items:{type:"string"}}},required:["headline","whatChanged","evidence","risks","missingQualification","closeDateCredibility","actions","confidence","explanation","dataGaps"]} as const;
export const forecastExplanationSchema={type:"object",additionalProperties:false,properties:{headline:{type:"string"},forecastTotal:{type:"number"},commitTotal:{type:"number"},bestCaseTotal:{type:"number"},pipelineTotal:{type:"number"},movements:{type:"array",items:{type:"string"}},closeDateRisks:{type:"array",items:{type:"string"}},commitDrivers:{type:"array",items:{type:"string"}},coverageGaps:{type:"array",items:{type:"string"}},actions:{type:"array",items:{type:"string"}},confidence:{type:"string",enum:["Low","Medium","High"]},explanation:{type:"string"},dataGaps:{type:"array",items:{type:"string"}}},required:["headline","forecastTotal","commitTotal","bestCaseTotal","pipelineTotal","movements","closeDateRisks","commitDrivers","coverageGaps","actions","confidence","explanation","dataGaps"]} as const;
