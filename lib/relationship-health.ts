export type HealthRow=Record<string,unknown>;
export type RelationshipHealthComponent={key:string;label:string;weight:number;points:number;evidence:string[];dataGaps:string[]};
export type MeaningfulInteraction={id:string;kind:"Inbound reply"|"Completed meeting"|"Call with outcome"|"Demonstration"|"Proposal review"|"Customer decision";weight:number;date:string;summary:string;contactId:string|null;threadKey:string|null};
export type RelationshipHealthResult={score:number;band:"Strong"|"Stable"|"Needs attention"|"At risk";provisional:boolean;confidence:"High"|"Medium"|"Low";confidenceScore:number;components:RelationshipHealthComponent[];evidence:string[];dataGaps:string[];meaningfulInteractions:MeaningfulInteraction[]};

const day=86400000;
const value=(row:HealthRow,...keys:string[])=>{for(const key of keys)if(row[key]!==undefined)return row[key];return undefined};
const string=(row:HealthRow,...keys:string[])=>String(value(row,...keys)??"").trim();
const number=(row:HealthRow,...keys:string[])=>Number(value(row,...keys)||0);
const truthy=(row:HealthRow,...keys:string[])=>{const current=value(row,...keys);return current===true||current===1||current==="1"||current==="true"};
const daysSince=(date:string,now:number)=>Math.max(0,(now-Date.parse(date))/day);
const points=(value:number,max:number)=>Math.max(0,Math.min(max,Math.round(value)));
const dateLabel=(date:string)=>new Date(date).toISOString().slice(0,10);
const summary=(row:HealthRow)=>string(row,"subject")||string(row,"body").slice(0,120)||string(row,"type")||"Interaction";
const isPast=(date:string,now:number)=>Number.isFinite(Date.parse(date))&&Date.parse(date)<=now;
const negativeOutcome=(outcome:string)=>/(cancel|no[ -]?show|no answer|voicemail|unreach|reschedul|did not occur)/i.test(outcome);

export function meaningfulInteraction(row:HealthRow,now=Date.now()):MeaningfulInteraction|null{
  const type=string(row,"type").toLowerCase(),outcome=string(row,"outcome"),date=string(row,"happened_at","happenedAt");
  if(!isPast(date,now))return null;
  const base={id:String(value(row,"id")??""),date,summary:summary(row),contactId:value(row,"contact_id","contactId")==null?null:String(value(row,"contact_id","contactId")),threadKey:string(row,"thread_key","threadKey")||null};
  if(["email received","inbound email","email reply","inbound reply"].includes(type)||/reply received/i.test(outcome))return {...base,kind:"Inbound reply",weight:1};
  if(["meeting","calendar meeting","completed meeting"].includes(type)&&/(completed|held|attended|met)/i.test(outcome)&&!negativeOutcome(outcome))return {...base,kind:"Completed meeting",weight:3};
  if(type==="call"&&outcome&&!negativeOutcome(outcome))return {...base,kind:"Call with outcome",weight:2};
  if(["demo","demonstration"].includes(type)&&!negativeOutcome(outcome))return {...base,kind:"Demonstration",weight:4};
  if(type==="proposal review"&&!negativeOutcome(outcome))return {...base,kind:"Proposal review",weight:4};
  if(["decision","customer decision"].includes(type)&&!negativeOutcome(outcome))return {...base,kind:"Customer decision",weight:5};
  return null;
}

export function calculateRelationshipHealth(input:{deal:HealthRow;activities:HealthRow[];tasks:HealthRow[];stakeholders:HealthRow[];now?:Date}):RelationshipHealthResult{
  const nowDate=input.now||new Date(),now=nowDate.getTime(),today=nowDate.toISOString().slice(0,10),components:RelationshipHealthComponent[]=[];
  const meaningful=input.activities.map(row=>meaningfulInteraction(row,now)).filter((item):item is MeaningfulInteraction=>Boolean(item)).sort((a,b)=>b.date.localeCompare(a.date));

  const last=meaningful[0],recencyDays=last?daysSince(last.date,now):null;
  const recencyPoints=recencyDays==null?0:recencyDays<=3?25:recencyDays>=60?0:points(25*(60-recencyDays)/57,25);
  components.push({key:"recency",label:"Interaction recency",weight:25,points:recencyPoints,evidence:last?[`Last meaningful interaction: ${last.kind} on ${dateLabel(last.date)} (${Math.floor(recencyDays!)} days ago).`]:[],dataGaps:last?[]:["No meaningful customer interaction is recorded for this deal."]});

  const expectedOutbound=input.activities.filter(row=>{
    const type=string(row,"type").toLowerCase();return truthy(row,"response_expected","responseExpected")&&["email","email sent","outbound email"].includes(type)&&isPast(string(row,"happened_at","happenedAt"),now);
  });
  const outboundThreads=new Set(expectedOutbound.map(row=>string(row,"thread_key","threadKey")||`activity:${String(value(row,"id")??"")}`));
  const replyThreads=new Set(meaningful.filter(item=>item.kind==="Inbound reply"&&item.threadKey&&outboundThreads.has(item.threadKey)).map(item=>item.threadKey!));
  const replyRate=outboundThreads.size?replyThreads.size/outboundThreads.size:0,replyPoints=points(replyRate*15,15),replyGaps:string[]=[];
  if(!outboundThreads.size)replyGaps.push("No outbound email thread is marked as requiring a response.");
  if(expectedOutbound.some(row=>!string(row,"thread_key","threadKey")))replyGaps.push("Some response-required emails lack a thread identifier, so replies cannot be matched reliably.");
  components.push({key:"reply-frequency",label:"Reply frequency",weight:15,points:replyPoints,evidence:outboundThreads.size?[`${replyThreads.size} of ${outboundThreads.size} response-required outbound threads received a matched inbound reply (${Math.round(replyRate*100)}%).`]:[],dataGaps:replyGaps});

  const meetings=meaningful.filter(item=>item.kind==="Completed meeting"),lastMeeting=meetings[0],meetingDays=lastMeeting?daysSince(lastMeeting.date,now):null;
  const meetingPoints=meetingDays==null?0:meetingDays<=30?15:meetingDays>=60?0:points(15*(60-meetingDays)/30,15);
  components.push({key:"meeting-cadence",label:"Meeting cadence",weight:15,points:meetingPoints,evidence:lastMeeting?[`Last completed meeting was ${Math.floor(meetingDays!)} days ago; the default cadence is 30 days.`]:[],dataGaps:lastMeeting?[]:["No completed meeting with a recorded outcome is available."]});

  const stakeholderCount=new Set(input.stakeholders.filter(row=>value(row,"active")===undefined||truthy(row,"active")).map(row=>String(value(row,"contact_id","contactId")??value(row,"id")??""))).size;
  const stakeholderPoints=stakeholderCount>=4?20:stakeholderCount===3?18:stakeholderCount===2?14:stakeholderCount===1?8:0;
  components.push({key:"active-stakeholders",label:"Active stakeholders",weight:20,points:stakeholderPoints,evidence:stakeholderCount?[`${stakeholderCount} active deal stakeholder${stakeholderCount===1?" is":"s are"} assigned.`]:[],dataGaps:stakeholderCount?[]:["No active stakeholder is assigned to the deal."]});

  const openTasks=input.tasks.filter(row=>!truthy(row,"completed")),overdue=openTasks.filter(row=>string(row,"due_date","dueDate")&&string(row,"due_date","dueDate")<today),futureActivityFollowUp=input.activities.some(row=>string(row,"follow_up_at","followUpAt")>=today),hasNextStep=Boolean(string(input.deal,"next_step","nextStep")),missingFollowUp=!openTasks.length&&!futureActivityFollowUp&&!hasNextStep;
  const hygienePoints=points(15-Math.min(15,overdue.length*5)-(missingFollowUp?10:0),15),hygieneEvidence:string[]=[];
  if(openTasks.length)hygieneEvidence.push(`${openTasks.length} open follow-up task${openTasks.length===1?"":"s"}; ${overdue.length} overdue.`);
  if(hasNextStep)hygieneEvidence.push(`Deal next step: ${string(input.deal,"next_step","nextStep")}.`);
  if(futureActivityFollowUp)hygieneEvidence.push("A future follow-up date is recorded on an activity.");
  components.push({key:"follow-up-hygiene",label:"Follow-up hygiene",weight:15,points:hygienePoints,evidence:hygieneEvidence,dataGaps:missingFollowUp?["No open follow-up task, future follow-up date, or deal next step is recorded."]:[]});

  const recent=meaningful.filter(item=>daysSince(item.date,now)<30),previous=meaningful.filter(item=>{const days=daysSince(item.date,now);return days>=30&&days<60}),recentWeight=recent.reduce((sum,item)=>sum+item.weight,0),previousWeight=previous.reduce((sum,item)=>sum+item.weight,0);
  let trendPoints=0,trendDescription="";if(recentWeight||previousWeight){const ratio=recentWeight/Math.max(1,previousWeight);trendPoints=previousWeight===0&&recentWeight>0?8:ratio>=1.25?10:ratio>=.9?7:ratio>=.5?4:0;trendDescription=`Weighted engagement is ${recentWeight} in the latest 30 days versus ${previousWeight} in the previous 30.`}
  components.push({key:"engagement-trend",label:"Engagement trend",weight:10,points:trendPoints,evidence:trendDescription?[trendDescription]:[],dataGaps:recentWeight||previousWeight?[]:["No meaningful engagement is available in either 30-day comparison window."]});

  const dealCreated=string(input.deal,"created_at","createdAt"),historyDays=Number.isFinite(Date.parse(dealCreated))?daysSince(dealCreated,now):0,hasFollowUpData=hasNextStep||input.tasks.length>0||input.activities.some(row=>Boolean(string(row,"follow_up_at","followUpAt")));
  const confidenceScore=points(Math.min(25,historyDays/60*25)+Math.min(30,meaningful.length*6)+(outboundThreads.size?15:0)+(meetings.length?10:0)+(stakeholderCount?10:0)+(hasFollowUpData?10:0),100);
  const confidence=confidenceScore>=75?"High":confidenceScore>=45?"Medium":"Low",dataGaps=Array.from(new Set(components.flatMap(component=>component.dataGaps)));
  if(historyDays<60)dataGaps.unshift(`Only ${Math.floor(historyDays)} days of deal history are available for the 60-day trend window.`);
  if(meaningful.length<3)dataGaps.push(`Only ${meaningful.length} meaningful customer interaction${meaningful.length===1?" is":"s are"} available.`);
  const score=components.reduce((sum,component)=>sum+component.points,0),band=score>=80?"Strong":score>=60?"Stable":score>=40?"Needs attention":"At risk",provisional=historyDays<30||meaningful.length<3||confidenceScore<45;
  return {score,band,provisional,confidence,confidenceScore,components,evidence:Array.from(new Set(components.flatMap(component=>component.evidence))),dataGaps:Array.from(new Set(dataGaps)),meaningfulInteractions:meaningful};
}
