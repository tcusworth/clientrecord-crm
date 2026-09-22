import { meaningfulInteraction, type HealthRow } from "@/lib/relationship-health";

export const dealStakeholderRoles = [
  "Decision-maker",
  "Economic buyer",
  "Technical buyer",
  "Champion",
  "Blocker",
  "Influencer",
  "Legal/procurement",
  "User",
  "Other",
] as const;

export type DealStakeholderRole = typeof dealStakeholderRoles[number];
export type CoverageSeverity = "Info"|"Warning"|"Critical";
export type CoverageFinding = {key:string;title:string;detail:string;severity:CoverageSeverity;reason:string;evidence:string[];role?:DealStakeholderRole};
export type StageContext = {key:string;name:string;index:number;openStageCount:number;probability:number;kind:"Open"|"Won"|"Lost"};
export type StakeholderCoverageResult = {
  generatedAt:string;
  monitored:boolean;
  stage:{key:string;name:string;phase:"Early"|"Middle"|"Late"|"Contracting"|"Closed";progress:number;technical:boolean;contracting:boolean};
  activeStakeholderCount:number;
  rolesCovered:DealStakeholderRole[];
  keyStakeholders:Array<{id:string;contactId:string;name:string;role:DealStakeholderRole;lastEngagedAt:string|null;daysSinceLastEngagement:number|null;engagement:"Recent"|"Stale"|"No engagement"}>;
  findings:CoverageFinding[];
  counts:{critical:number;warning:number;info:number};
};

const day=86400000;
const value=(row:HealthRow,...keys:string[])=>{for(const key of keys)if(row[key]!==undefined)return row[key];return undefined};
const string=(row:HealthRow,...keys:string[])=>String(value(row,...keys)??"").trim();
const active=(row:HealthRow)=>{const current=value(row,"active");return current===undefined||current===true||current===1||current==="1"||current==="true"};
export function normalizeDealStakeholderRole(role:unknown):DealStakeholderRole{
  const current=String(role??"").trim();
  if(current==="Legal / procurement")return "Legal/procurement";
  if(current==="Colleague")return "Other";
  return dealStakeholderRoles.includes(current as DealStakeholderRole)?current as DealStakeholderRole:"Other";
}
const severity=(phase:StakeholderCoverageResult["stage"]["phase"],early:CoverageSeverity="Info",middle:CoverageSeverity="Warning",late:CoverageSeverity="Critical")=>phase==="Early"?early:phase==="Middle"?middle:late;

export function calculateStakeholderCoverage(input:{deal:HealthRow;stage:StageContext;stakeholders:HealthRow[];activities:HealthRow[];now?:Date}):StakeholderCoverageResult{
  const now=input.now||new Date(),nowMs=now.getTime(),stageName=`${input.stage.key} ${input.stage.name}`.toLowerCase(),openCount=Math.max(1,input.stage.openStageCount),progress=input.stage.kind==="Open"?Math.min(1,Math.max(0,(input.stage.index+1)/openCount)):1;
  const contracting=input.stage.kind==="Open"&&(/negotiat|contract|approval|procure|legal|security|close/.test(stageName)||progress>=.9);
  const technical=input.stage.kind==="Open"&&(/technical|demo|evaluation|pilot|solution|proposal/.test(stageName)||progress>=.65);
  const phase:StakeholderCoverageResult["stage"]["phase"]=input.stage.kind!=="Open"?"Closed":contracting?"Contracting":progress>=.65?"Late":progress>=.35?"Middle":"Early";
  const stage={key:input.stage.key,name:input.stage.name,phase,progress:Math.round(progress*100),technical,contracting};
  const people=input.stakeholders.filter(active).map(row=>({...row,normalizedRole:normalizeDealStakeholderRole(value(row,"role"))}));
  const roles=new Set(people.map(row=>row.normalizedRole));
  const meaningful=input.activities.map(row=>meaningfulInteraction(row,nowMs)).filter(item=>item?.contactId);
  const keyRoles:DealStakeholderRole[]=["Decision-maker","Economic buyer","Technical buyer","Champion"];
  const keyStakeholders=people.filter(row=>keyRoles.includes(row.normalizedRole)).map(row=>{
    const contactId=String(value(row,"contact_id","contactId")??""),last=meaningful.filter(item=>item?.contactId===contactId).sort((a,b)=>String(b?.date).localeCompare(String(a?.date)))[0],days=last?Math.floor(Math.max(0,(nowMs-Date.parse(last.date))/day)):null;
    return {id:String(value(row,"id")??""),contactId,name:string(row,"contact_name","contactName")||"Unnamed contact",role:row.normalizedRole,lastEngagedAt:last?.date||null,daysSinceLastEngagement:days,engagement:(days==null?"No engagement":days>30?"Stale":"Recent") as "Recent"|"Stale"|"No engagement"};
  });
  const findings:CoverageFinding[]=[];
  const add=(finding:CoverageFinding)=>findings.push(finding);
  if(input.stage.kind==="Open"){
    if(people.length===1)add({key:"single-contact",title:"Only one active contact",detail:"Add another stakeholder to reduce single-thread risk.",severity:severity(phase,"Info","Warning","Critical"),reason:"The deal depends on one active relationship.",evidence:[`${string(people[0],"contact_name","contactName")||"One contact"} is the only active stakeholder.`]});
    if(!roles.has("Decision-maker"))add({key:"missing-decision-maker",title:"No decision-maker",detail:"Identify the person who owns or approves the buying decision.",severity:severity(phase),reason:`Decision-maker coverage is ${phase.toLowerCase()}-stage ${phase==="Early"?"guidance":"risk"}.`,evidence:[`Current stage: ${input.stage.name} (${stage.progress}% through open stages).`],role:"Decision-maker"});
    if(!roles.has("Champion"))add({key:"missing-champion",title:"No champion",detail:"Develop an internal advocate who will advance the deal.",severity:severity(phase,"Info","Warning",contracting?"Critical":"Warning"),reason:"No active stakeholder is assigned as champion.",evidence:[`${people.length} active stakeholder${people.length===1?" is":"s are"} mapped.`],role:"Champion"});
    if(!roles.has("Economic buyer"))add({key:"missing-economic-buyer",title:"No economic buyer",detail:"Identify the person accountable for budget and commercial approval.",severity:severity(phase,"Info",technical?"Warning":"Info",contracting?"Critical":"Warning"),reason:`Budget authority becomes more important as the deal reaches ${input.stage.name}.`,evidence:[`Pipeline phase: ${phase}.`],role:"Economic buyer"});
    if(roles.has("Blocker")&&!roles.has("Champion"))add({key:"blocker-without-champion",title:"Blocker without a champion",detail:"Build a counterbalancing internal relationship before advancing.",severity:severity(phase,"Warning","Warning","Critical"),reason:"An active blocker is recorded, but no champion is present.",evidence:[`${people.filter(row=>row.normalizedRole==="Blocker").length} active blocker${people.filter(row=>row.normalizedRole==="Blocker").length===1?"":"s"}.`]});
    const stale=keyStakeholders.filter(person=>person.engagement!=="Recent");
    if(stale.length)add({key:"stale-key-stakeholders",title:"No recent engagement with key stakeholders",detail:"Re-engage the named stakeholders or confirm that they remain active in the buying process.",severity:severity(phase,"Info","Warning","Critical"),reason:"Key stakeholders have no meaningful interaction in the last 30 days.",evidence:stale.map(person=>`${person.name} · ${person.role} · ${person.daysSinceLastEngagement==null?"no recorded engagement":`${person.daysSinceLastEngagement} days since engagement`}.`)});
    if(technical&&!roles.has("Technical buyer"))add({key:"missing-technical-buyer",title:"No technical buyer",detail:"Add the technical evaluator or solution owner before the deal advances.",severity:contracting?"Critical":"Warning",reason:`${input.stage.name} is treated as a later technical stage.`,evidence:[`Stage progress: ${stage.progress}%.`],role:"Technical buyer"});
    if(contracting&&!roles.has("Legal/procurement"))add({key:"missing-procurement",title:"No legal or procurement contact",detail:"Identify the person responsible for contracting, security, or procurement.",severity:"Critical",reason:`${input.stage.name} is treated as an approval or contracting stage.`,evidence:["No active stakeholder has the Legal/procurement role."],role:"Legal/procurement"});
  }
  const rank:Record<CoverageSeverity,number>={Critical:0,Warning:1,Info:2};findings.sort((a,b)=>rank[a.severity]-rank[b.severity]||a.title.localeCompare(b.title));
  return {generatedAt:now.toISOString(),monitored:input.stage.kind==="Open",stage,activeStakeholderCount:people.length,rolesCovered:Array.from(roles).sort() as DealStakeholderRole[],keyStakeholders,findings,counts:{critical:findings.filter(item=>item.severity==="Critical").length,warning:findings.filter(item=>item.severity==="Warning").length,info:findings.filter(item=>item.severity==="Info").length}};
}
