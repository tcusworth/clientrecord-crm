export type FollowUpCommitment={text:string;owner:string;dueDate:string;party:"Customer"|"Internal"|"Shared"};
export type FollowUpStep={text:string;owner:string;dueDate:string};
export type FollowUpDraft={
  emailSubject:string;
  personalizedMessage:string;
  discussionSummary:string;
  decisions:string[];
  commitments:FollowUpCommitment[];
  nextSteps:FollowUpStep[];
  confidence:"Low"|"Medium"|"High";
  explanation:string;
  dataGaps:string[];
};

type Row=Record<string,unknown>;
const clean=(value:unknown,max=4000)=>String(value??"").trim().slice(0,max);
const jsonList=(value:unknown)=>{try{const parsed=JSON.parse(String(value||"[]"));return Array.isArray(parsed)?parsed:[]}catch{return []}};
const strings=(value:unknown)=>jsonList(value).map(item=>typeof item==="string"?item:clean((item as Row).text)).filter(Boolean);
const date=(value:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(clean(value,10))?clean(value,10):"";
const firstName=(value:unknown)=>clean(value,120).split(/\s+/)[0]||"there";
const sentence=(value:string)=>value&&!/[.!?]$/.test(value)?`${value}.`:value;
const lineItems=(value:string,label:RegExp)=>value.split(/\r?\n/).map(item=>item.trim()).filter(item=>label.test(item)).map(item=>item.replace(label,"").trim()).filter(Boolean);

export function normalizeFollowUpDraft(value:unknown):FollowUpDraft{
  const row=(value&&typeof value==="object"?value:{}) as Row;
  const list=(input:unknown,max=30)=>Array.isArray(input)?input.map(item=>clean(item,2000)).filter(Boolean).slice(0,max):[];
  const commitments=Array.isArray(row.commitments)?row.commitments.map(item=>{const record=(item&&typeof item==="object"?item:{}) as Row;const party=clean(record.party,20);return{text:clean(record.text,2000),owner:clean(record.owner,200),dueDate:date(record.dueDate),party:(party==="Customer"||party==="Internal"||party==="Shared"?party:"Shared") as FollowUpCommitment["party"]}}).filter(item=>item.text).slice(0,30):[];
  const nextSteps=Array.isArray(row.nextSteps)?row.nextSteps.map(item=>{const record=(item&&typeof item==="object"?item:{}) as Row;return{text:clean(record.text,2000),owner:clean(record.owner,200),dueDate:date(record.dueDate)}}).filter(item=>item.text).slice(0,30):[];
  const confidence=clean(row.confidence,20);
  return {emailSubject:clean(row.emailSubject,240),personalizedMessage:clean(row.personalizedMessage,12000),discussionSummary:clean(row.discussionSummary,8000),decisions:list(row.decisions),commitments,nextSteps,confidence:confidence==="High"||confidence==="Medium"?confidence:"Low",explanation:clean(row.explanation,4000),dataGaps:list(row.dataGaps,20)};
}

export function buildDeterministicFollowUpDraft(input:{sourceType:"meeting"|"note"|"transcript";source:Row;deal:Row;company:Row|null;stakeholders:Row[];transcriptText?:string}){
  const {sourceType,source,deal,company,stakeholders}=input,owner=clean(deal.owner,200),companyName=clean(company?.name||deal.company,240)||"your team",primary=stakeholders.find(item=>Boolean(item.is_primary))||stakeholders.find(item=>["Decision-maker","Economic buyer","Champion"].includes(clean(item.role)))||stakeholders[0],recipient=firstName(primary?.contact_name),subject=clean(source.subject||source.title||deal.name,240)||"our conversation";
  const raw=clean(input.transcriptText||source.body||source.summary,20000),meetingDecisions=sourceType==="meeting"?strings(source.decisions_json):[],parsedDecisions=lineItems(raw,/^(?:decision|agreed|agreement)\s*[:\-]\s*/i),decisions=[...new Set([...meetingDecisions,...parsedDecisions])].slice(0,20);
  const customer=sourceType==="meeting"?strings(source.customer_commitments_json):[],internal=sourceType==="meeting"?strings(source.internal_commitments_json):[],parsedCommitments=lineItems(raw,/^(?:commitment|committed|customer commitment|internal commitment)\s*[:\-]\s*/i);
  const commitments:FollowUpCommitment[]=[...customer.map(text=>({text,owner:clean(primary?.contact_name,200)||companyName,dueDate:"",party:"Customer" as const})),...internal.map(text=>({text,owner,dueDate:"",party:"Internal" as const})),...parsedCommitments.map(text=>({text,owner:"",dueDate:"",party:"Shared" as const}))];
  const structuredSteps=sourceType==="meeting"?jsonList(source.next_steps_json).map(item=>{const row=(item&&typeof item==="object"?item:{text:item}) as Row;return{text:clean(row.text,2000),owner:clean(row.owner,200)||owner,dueDate:date(row.dueDate)}}).filter(item=>item.text):[],parsedSteps=lineItems(raw,/^(?:next step|action|follow[- ]?up)\s*[:\-]\s*/i).map(text=>({text,owner,dueDate:""})),fallbackStep=clean(deal.next_step,2000),nextSteps=[...structuredSteps,...parsedSteps];if(!nextSteps.length&&fallbackStep)nextSteps.push({text:fallbackStep,owner,dueDate:""});
  const summary=raw||`${subject} is recorded against ${clean(deal.name,240)}.`,summarySentence=sentence(summary.split(/\n+/).map(item=>item.trim()).filter(Boolean).slice(0,3).join(" ").slice(0,1200)),decisionCopy=decisions.length?` We agreed ${decisions.map(sentence).join(" ")}`:"",stepCopy=nextSteps.length?` Next, ${nextSteps.map(item=>sentence(item.text)).join(" ")}`:"";
  const dataGaps:string[]=[];if(!raw)dataGaps.push("The selected source has no detailed notes or transcript text.");if(!decisions.length)dataGaps.push("No explicit decisions are recorded.");if(!commitments.length)dataGaps.push("No explicit commitments are recorded.");if(!nextSteps.length)dataGaps.push("No next steps are recorded.");if(!primary)dataGaps.push("No active stakeholder is available for personalization.");
  const confidence:"Low"|"Medium"|"High"=dataGaps.length<=1?"High":dataGaps.length<=3?"Medium":"Low";
  return normalizeFollowUpDraft({
    emailSubject:`Follow-up: ${subject}`,
    personalizedMessage:`Hi ${recipient},\n\nThank you for the conversation about ${subject}. ${summarySentence}${decisionCopy}${stepCopy}\n\nPlease let me know if I missed anything or if any of the actions should change.\n\nBest,`,
    discussionSummary:summarySentence,
    decisions,
    commitments,
    nextSteps,
    confidence,
    explanation:`Drafted from the selected ${sourceType}, the deal record, and active stakeholder context. No information outside ClientRecord was introduced.`,
    dataGaps,
  });
}

export const followUpDraftSchema={
  type:"object",additionalProperties:false,
  properties:{
    emailSubject:{type:"string"},personalizedMessage:{type:"string"},discussionSummary:{type:"string"},
    decisions:{type:"array",items:{type:"string"}},
    commitments:{type:"array",items:{type:"object",additionalProperties:false,properties:{text:{type:"string"},owner:{type:"string"},dueDate:{type:"string"},party:{type:"string",enum:["Customer","Internal","Shared"]}},required:["text","owner","dueDate","party"]}},
    nextSteps:{type:"array",items:{type:"object",additionalProperties:false,properties:{text:{type:"string"},owner:{type:"string"},dueDate:{type:"string"}},required:["text","owner","dueDate"]}},
    confidence:{type:"string",enum:["Low","Medium","High"]},explanation:{type:"string"},dataGaps:{type:"array",items:{type:"string"}},
  },
  required:["emailSubject","personalizedMessage","discussionSummary","decisions","commitments","nextSteps","confidence","explanation","dataGaps"],
} as const;
